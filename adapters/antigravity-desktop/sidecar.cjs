const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { json, save, jobPath, cancelled, submissionArgs } = require('./core.cjs');
const root = process.env.LARK_ANTIGRAVITY_DESKTOP_ROOT;
if (!root || !process.env.ANTIGRAVITY_LS_ADDRESS) throw Error('Desktop Sidecar environment is required');
fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
const active = new Set();
const appParentPid = process.ppid;
function appParentAlive() {
  if (!Number.isInteger(appParentPid) || appParentPid <= 1) return true;
  try { process.kill(appParentPid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function api(args) {
  return new Promise((resolve, reject) => {
    // This is the App-provided agentapi executable, not agy headless.
    const child = cp.spawn(process.env.ANTIGRAVITY_AGENTAPI_EXE, ['agentapi', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Desktop agentapi request timed out')); }, 15000);
    child.stdout.on('data', data => { text += data; if (text.length > 2e6) child.kill(); });
    child.stderr.resume(); // Diagnostics must not block a machine-readable response.
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); try { const value = JSON.parse(text); if (code || value.error) reject(Error(value.error || 'Desktop agentapi failed')); else resolve(value); } catch { reject(Error('Invalid desktop agentapi response')); } });
  });
}
function killTools(dir, id) {
  const tools = path.join(dir, 'tools'); if (!fs.existsSync(tools)) return;
  for (const file of fs.readdirSync(tools)) {
    try {
      const record = json(path.join(tools, file)); if (record.runId !== id || !Number.isInteger(record.pid)) continue;
      if (process.platform === 'win32') {
        // Verify command ownership before killing a PID which could have been reused.
        const check = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}'; if($p.CommandLine -like '*core.cjs*exec*${id}*'){ & taskkill.exe /PID ${record.pid} /T /F | Out-Null; exit $LASTEXITCODE }; exit 0`;
        const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
        if (result.status === 0) fs.rmSync(path.join(tools, file), { force: true });
      } else process.kill(record.pid, 'SIGTERM');
    } catch { /* An exited job tool requires no cleanup. */ }
  }
}
async function start(id) {
  if (active.has(id)) return; active.add(id);
  const dir = jobPath(root, id);
  try {
    const request = json(path.join(dir, 'request.json'));
    const workspace = process.env.LARK_ANTIGRAVITY_WORKSPACE_ROOT;
    if (!workspace) throw Error('Sidecar workspace binding is missing');
    const relative = path.relative(path.resolve(workspace), path.resolve(request.cwd));
    if (!request.memoryMode && (relative.startsWith('..') || path.isAbsolute(relative))) throw Error('Requested workspace is outside the bound App project');
    if (cancelled(dir, request) || fs.existsSync(path.join(dir, 'result.json'))) return;
    if (fs.existsSync(path.join(dir, 'conversation.json'))) return; // Never replay accepted work after restart.
    if (fs.existsSync(path.join(dir, 'claimed.json'))) {
      save(path.join(dir, 'result.json'), { type: 'error', reason: 'failed', message: 'Desktop submission outcome uncertain after restart; refusing duplicate execution' }); return;
    }
    save(path.join(dir, 'claimed.json'), { at: Date.now() });
    const marker = `FEISHU_DESKTOP_RUN:${id}:${request.nonce}`;
    const prompt = `${marker}\nThis is an authorized, unattended Feishu bridge run. Work in ${request.cwd}. Do not repeat the binding marker in your reply. Never wait for App questions or approval dialogs; explain required information or approval in a final answer instead.\n${request.prompt}`;
    const result = await api(submissionArgs(request, prompt, process.env.LARK_ANTIGRAVITY_MEMORY_MODEL || 'flash_lite'));
    const conversationId = result.response?.newConversation?.conversationId;
    if (!/^[a-f0-9-]{36}$/i.test(conversationId || '')) throw Error('Missing desktop conversation ID');
    save(path.join(root, 'conversations', conversationId + '.json'), { runId: id, nonce: request.nonce });
    save(path.join(dir, 'conversation.json'), { conversationId });
  } catch (error) { save(path.join(dir, 'result.json'), { type: 'error', reason: 'failed', message: String(error.message).slice(0, 500) }); }
  finally { active.delete(id); }
}
setInterval(() => {
  // An App update can leave its old Sidecar behind with a dead language-server
  // address. It must not race the replacement Sidecar for jobs or heartbeat.
  if (!appParentAlive()) { process.exit(0); return; }
  let jobs;
  try {
    save(path.join(root, 'heartbeat.json'), { at: Date.now(), pid: process.pid, transport: 'antigravity-app', projectId: process.env.ANTIGRAVITY_PROJECT_ID, workspaceRoot: process.env.LARK_ANTIGRAVITY_WORKSPACE_ROOT });
    jobs = fs.readdirSync(path.join(root, 'runs'));
  } catch { return; } // Storage loss expires availability; retry without crashing the App Sidecar.
  for (const id of jobs) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) continue;
    const dir = jobPath(root, id);
    try {
      if (!fs.existsSync(path.join(dir, 'request.json'))) continue;
      const request = json(path.join(dir, 'request.json'));
      const lease = path.join(dir, 'lease.json');
      if (fs.existsSync(lease) && Date.now() - json(lease).at > 20000 && !fs.existsSync(path.join(dir, 'result.json'))) save(path.join(dir, 'cancel.json'), { reason: 'bridge lease expired' });
      if (cancelled(dir, request)) killTools(dir, id);
      else if (!fs.existsSync(path.join(dir, 'result.json'))) void start(id);
    } catch { /* Partial atomic publication is retried next tick. */ }
  }
}, 1000);
