const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file); }
function jobPath(root, id) { if (!ID.test(id)) throw Error('Invalid desktop run ID'); return path.join(root, 'runs', id); }
function emit(dir, event) { fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }); }
function cancelled(dir, request) {
  if (fs.existsSync(path.join(dir, 'cancel.json')) || fs.existsSync(path.join(dir, 'result.json')) || Date.now() > request.expires) return true;
  try { return Date.now() - json(path.join(dir, 'lease.json')).at > 20000; } catch { return true; }
}
function resolveJob(root, input) {
  if (!/^[a-f0-9-]{36}$/i.test(input.conversationId || '')) return;
  const mapping = path.join(root, 'conversations', input.conversationId + '.json');
  if (fs.existsSync(mapping)) {
    const m = json(mapping), dir = jobPath(root, m.runId), request = json(path.join(dir, 'request.json'));
    if (request.nonce === m.nonce) return { dir, request };
    return;
  }
  // Inspect only the first user step of an unmapped conversation, never private reasoning.
  const expected = path.join(process.env.USERPROFILE || process.env.HOME, '.gemini', 'antigravity', 'brain', input.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (canonical(input.transcriptPath || '') !== canonical(expected) || !fs.existsSync(expected)) return;
  const fd = fs.openSync(expected, 'r'); const buffer = Buffer.alloc(65536); let n;
  try { n = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
  const first = buffer.subarray(0, n).toString('utf8').split('\n')[0];
  let record; try { record = JSON.parse(first); } catch { return; }
  if (record.type !== 'USER_INPUT') return;
  const marker = String(record.content).match(/FEISHU_DESKTOP_RUN:([a-zA-Z0-9_-]{1,100}):([a-f0-9]{32})/);
  if (!marker) return;
  const dir = jobPath(root, marker[1]);
  if (!fs.existsSync(path.join(dir, 'request.json'))) return;
  const request = json(path.join(dir, 'request.json'));
  if (request.nonce !== marker[2]) return;
  save(mapping, { runId: request.runId, nonce: request.nonce });
  if (!fs.existsSync(path.join(dir, 'conversation.json'))) save(path.join(dir, 'conversation.json'), { conversationId: input.conversationId });
  return { dir, request };
}
function finalResponse(file) {
  let answer = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const step = JSON.parse(line);
    if (step.type === 'PLANNER_RESPONSE' && typeof step.content === 'string') answer = step.content;
  }
  return answer;
}
function hook(root, event, input) {
  const job = resolveJob(root, input); if (!job) return event === 'PreToolUse' ? { decision: 'allow' } : {};
  const { dir, request } = job, stop = cancelled(dir, request);
  if (event === 'PreToolUse') {
    if (stop || request.memoryMode) return { decision: 'deny', reason: stop ? 'This Feishu run has been cancelled.' : 'Memory synthesis cannot use tools.' };
    if (['ask_question', 'ask_permission'].includes(input.toolCall?.name)) return { decision: 'deny', reason: 'This run is unattended. Explain missing information or approval in your final answer instead of waiting for App interaction.' };
    if (input.toolCall?.name === 'invoke_subagent' && Array.isArray(input.toolCall.args?.Subagents)) {
      const marker = `FEISHU_DESKTOP_RUN:${request.runId}:${request.nonce}`;
      return { decision: 'allow', overwrite: { Subagents: input.toolCall.args.Subagents.map(spec => ({ ...spec, Prompt: `${marker}\n${spec.Prompt || ''}` })) } };
    }
    if (input.toolCall?.name === 'run_command') {
      const command = input.toolCall.args?.CommandLine;
      if (typeof command !== 'string') return { decision: 'deny', reason: 'Missing command' };
      const cwd = input.toolCall.args?.Cwd || request.cwd;
      const relative = path.relative(path.resolve(request.workspaceRoot || request.cwd), path.resolve(cwd));
      if (relative.startsWith('..') || path.isAbsolute(relative)) return { decision: 'deny', reason: 'Tool cwd is outside the bound App project.' };
      const encoded = Buffer.from(JSON.stringify({ command, cwd })).toString('base64');
      // Credentials remain in the private request file, never in tool arguments/transcripts.
      const wrapper = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" "${__filename}" exec "${root}" "${request.runId}" ${encoded}`;
      return { decision: 'allow', overwrite: { CommandLine: wrapper } };
    }
    return { decision: 'allow' };
  }
  if (event === 'PostInvocation' && stop) return { terminationBehavior: 'terminate' };
  if (event === 'Stop') {
    const primary = path.join(dir, 'conversation.json');
    if (fs.existsSync(primary) && json(primary).conversationId !== input.conversationId) {
      emit(dir, { type: 'activity', summary: 'desktop subagent lifecycle' }); return {};
    }
    if (!input.fullyIdle) { emit(dir, { type: 'activity', summary: 'desktop background work still active' }); return {}; }
    if (!fs.existsSync(path.join(dir, 'result.json'))) {
      const success = !stop && !input.error && ['model_stop', 'NO_TOOL_CALL'].includes(input.terminationReason);
      const text = success ? finalResponse(input.transcriptPath) : '';
      save(path.join(dir, 'result.json'), success && text.trim()
        ? { type: 'done', text, conversationId: input.conversationId }
        : { type: 'error', reason: stop ? 'interrupted' : 'failed', message: stop ? 'Desktop run cancelled' : `Desktop stopped: ${input.terminationReason || 'unknown'}${input.error ? ': ' + String(input.error).slice(0, 500) : ''}` });
    }
    return {};
  }
  if (event === 'PreInvocation' || event === 'PostToolUse') emit(dir, { type: 'activity', summary: event === 'PreInvocation' ? 'desktop model invocation' : 'desktop tool completed' });
  return {};
}
async function execute(root, id, encoded) {
  const dir = jobPath(root, id), request = json(path.join(dir, 'request.json'));
  if (cancelled(dir, request) || request.memoryMode) throw Error('Desktop run is not authorized for tool execution');
  const { command, cwd } = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (typeof command !== 'string' || typeof cwd !== 'string') throw Error('Invalid tool request');
  const relative = path.relative(path.resolve(request.workspaceRoot || request.cwd), path.resolve(cwd));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Tool cwd is outside the bound App project');
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] : ['-c', command];
  const pidFile = path.join(dir, 'tools', process.pid + '.json');
  save(pidFile, { pid: process.pid, runId: id });
  const child = cp.spawn(shell, args, { cwd, env: toolEnvironment(process.env, request.env), stdio: 'inherit', windowsHide: true });
  child.on('error', error => { fs.rmSync(pidFile, { force: true }); console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { fs.rmSync(pidFile, { force: true }); process.exitCode = code ?? 1; });
}
function toolEnvironment(parent, bound) {
  const env = { ...parent };
  for (const key of Object.keys(env)) if (/^ANTIGRAVITY_|^LARK_|^LARKSUITE_/i.test(key)) delete env[key];
  return { ...env, ...bound };
}
function submissionArgs(request, prompt, memoryModel = 'flash_lite') {
  if (!['flash_lite', 'flash', 'pro'].includes(memoryModel)) throw Error('Unsupported App memory model tier');
  return ['new-conversation', ...(request.memoryMode ? ['--model=' + memoryModel] : []), '--title=Feishu worker ' + request.runId.slice(0, 8), prompt];
}
module.exports = { json, save, jobPath, emit, cancelled, resolveJob, finalResponse, hook, toolEnvironment, submissionArgs };
if (require.main === module) {
  const [mode, root, arg, encoded] = process.argv.slice(2);
  if (mode === 'exec') execute(root, arg, encoded).catch(error => { console.error(error.message); process.exitCode = 1; });
  else if (mode === 'hook') {
    save(path.join(root, 'hooks-seen.json'), { event: arg, at: Date.now() });
    let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => data += part);
    process.stdin.on('end', () => { try { process.stdout.write(JSON.stringify(hook(root, arg, JSON.parse(data)))); } catch { process.stdout.write(arg === 'PreToolUse' ? '{"decision":"deny","reason":"Desktop bridge hook failed"}' : '{}'); } });
  }
}
