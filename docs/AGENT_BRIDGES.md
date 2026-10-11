# Agent Bridge Configuration

[Back to README](../README.md) | [中文](./AGENT_BRIDGES.zh-CN.md) |
[Collaboration design](./DESIGN.md) | [Windows operations](./WINDOWS_OPERATIONS.md)

## Branch Answer

For a second computer that runs a Worker but must not start a Hub, clone
`release/worker` and follow the Worker deployment guide. The central Hub
computer uses `release/hub`. Develop on the matching `develop/worker` or
`develop/hub` branch; `archive/*` is for rollback/history only.

## Shared Prerequisites

1. Windows, Git, Node.js 20.12+ and pnpm; Node.js 22+ is recommended for Harness.
2. Every local agent is installed and logged in through its own interactive flow.
3. One Feishu PersonalAgent app per bot.
4. One distinct `LARK_CHANNEL_HOME` or profile per bot. Bots must not share an
   App Secret, a session lock or a process registration.
5. `pnpm install` and `pnpm build` completed in this checkout.

Enable the bot capability and persistent-connection message event in each
Feishu app. App Secrets go to the local encrypted profile store, never scripts
or Git.

## Agent Kinds

`--agent` accepts exactly four kinds: `claude`, `codex`, `antigravity` and
`deepseek-harness`. Any other value is rejected while the profile is resolved.
Hermes is not one of them; it joins the same collaboration through its Hook
(see [Hermes](#hermes)).

| Kind | Engine | Run-time binary | Command line built by the adapter |
| --- | --- | --- | --- |
| `claude` | Claude Code | the literal `claude` resolved on `PATH` | `claude -p --output-format stream-json --verbose --permission-mode … --append-system-prompt-file …` |
| `codex` | Codex CLI | `codex.binaryPath` from the profile | `codex exec --json --sandbox … -C <cwd> -` |
| `antigravity` | Antigravity CLI (`agy`) | `antigravity.binaryPath` from the profile | `agy --input-format stream-json --output-format stream-json --print-timeout … --add-dir <cwd>` |
| `deepseek-harness` | DeepSeek Harness | `deepseekHarness.binaryPath` (Node) plus `deepseekHarness.entryPath` | `node -e <bootstrap> <entryPath>`; the bootstrap imports the entry |

The binary environment variables are bootstrap inputs, not run-time switches:

| Variable | Engine | Where the bridge reads it |
| --- | --- | --- |
| `LARK_CHANNEL_CLAUDE_BIN` | `claude` | first-run agent detection only; a run always spawns `claude` |
| `LARK_CHANNEL_CODEX_BIN` | `codex` | profile creation and migration, stored as `codex.binaryPath` |
| `LARK_CHANNEL_ANTIGRAVITY_BIN` | `antigravity` | profile creation and migration, plus first-run detection; also re-exported by the generated Windows service launcher |
| `LARK_CHANNEL_NODE_BIN` | `deepseek-harness` | profile creation, stored as `deepseekHarness.binaryPath` |
| `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` | `deepseek-harness` | profile creation, stored as `deepseekHarness.entryPath`; also gates first-run detection |

“Profile creation” means both `profile create` and the first `run` that has to
create the profile. Exporting one of these immediately before `run` therefore
only matters for the run that creates the profile. Once the profile holds a
resolved `binaryPath`, changing the variable does not move an existing profile:
recreate the profile or edit it. Claude Code is the one exception, since it has
no binary field at all. To drive a build outside `PATH`, put its directory on
`PATH`.

## Permissions

Each profile carries one canonical access pair:

```json
"permissions": {
  "defaultAccess": "full",
  "maxAccess": "full"
}
```

Both values are `read-only`, `workspace` or `full`, ordered
`read-only < workspace < full`, and both default to `full`. `defaultAccess` may
not be written above `maxAccess`; the run policy additionally clamps whatever
it finds, so a run is never granted more than `maxAccess`.

| Resolved access | Codex `--sandbox` | Claude `--permission-mode` |
| --- | --- | --- |
| `read-only` | `read-only` | `plan` |
| `workspace` | `workspace-write` | `acceptEdits` |
| `full` | `danger-full-access` | `bypassPermissions` |

Codex additionally pins its approval policy to `never` and inherits the whole
environment. An optional `permissions.claude.permissionMode` can tighten Claude
further, but only while its implied level stays at or below the resolved access,
so it can never widen a run: `plan` means `read-only`, `default` and
`acceptEdits` mean `workspace`, `bypassPermissions` means `full`.

Every run forwards the resolved `sandbox` and `permissionMode` in its run
options, but the Antigravity and DeepSeek Harness adapters read neither, so no
permission flag derived from that pair reaches either engine. Antigravity's only
permission knobs are the profile fields `antigravity.dangerouslySkipPermissions`
(`--dangerously-skip-permissions`) and `antigravity.sandbox` (`--sandbox`), and
profile creation writes `dangerouslySkipPermissions: true`. DeepSeek Harness is
started with no sandbox or permission flag at all.

A legacy `sandbox` block (`default` / `max` / `defaultMode` / `maxMode` with
`read-only` / `workspace-write` / `danger-full-access` values) is still read as
input, but only when there is no `permissions` block, and it is translated onto
the same three levels. It is never written back: `config.json` persists
`permissions` only, so the legacy block survives purely as a load-time input.

## Unattended Artifact Delivery

Every bridge-launched Agent runs as an unattended background worker. The bridge
sets `LARK_CHANNEL_UNATTENDED=1` and injects the same runtime contract into every
maintained Agent: create the requested artifact with non-interactive libraries
or command-line tools, validate it headlessly, and return it through Feishu (or
`collab-artifact.cmd publish` in a collaboration task).

Agents must not launch or automate WPS, Microsoft Office, file pickers, save
dialogs, or other interactive desktop applications. Office/WPS COM automation,
including `PowerPoint.Application`, `New-Object -ComObject`, and `win32com`, is
not a supported artifact path even when configured as hidden: the registered
COM server can still display a window or confirmation dialog in the user's
desktop session. If a reliable headless generator or validator is unavailable,
the Agent reports that missing capability instead of asking the user to finish
the task on the computer.

All four maintained Agent paths receive the same Hub-generated collaboration
prompt. The prompt names the local journal scope and the delegation and artifact
commands, and carries no catalog of historical files. An Agent can run
`collab-artifact.cmd resolve --task TASK --actor AGENT --name "EXACT_NAME"` for
one additional file, or `--list` to enumerate the Artifacts visible to that
task. Hermes does not build a separate full-history prompt.

`collab-artifact.cmd publish` owns the whole delivery path. If the current
private lark-channel workspace has lost its bot binding, the command repairs
that isolated workspace as `bot-only` and retries once before failing. Agents
must not substitute their native `.artifacts` staging directory, and must not
tell the user to restart/doctor the Bridge unless this delivery command itself
still returns an exact error after the retry.

## Claude Code

Prerequisite: an interactive Claude Code login that works on its own, so
`claude --version` and an ordinary prompt both succeed. On Windows `claude`
resolves to the `claude.cmd` shim on `PATH`.

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\claude'
node .\dist\cli.js run --profile claude --agent claude --workspace C:\workspaces\claude
```

The first run creates and binds the Feishu app for profile `claude`. The
collaboration manifest launches the same command under a stable Agent ID such
as `claude`.

A run always spawns the literal command `claude`. `LARK_CHANNEL_CLAUDE_BIN` is
consulted only by first-run agent detection, never by a run.

Per run the adapter builds:

```text
claude -p --output-format stream-json --verbose \
  --permission-mode <mode> --append-system-prompt-file <temp file> \
  [--resume <sessionId>] [--model <model>]
```

The prompt goes to stdin and the bridge system prompt to a throwaway temp file,
so no `<` or `>` ever reaches `cmd.exe`. Output is newline-delimited
`stream-json`: assistant text, thinking and `tool_use` blocks become bridge
events in order, tool results are fed back to the card, and the final `result`
line yields token usage and cost just before the run is marked done.

Claude and Codex are the resumable kinds; Antigravity and DeepSeek Harness are
stateless. `/resume` lists the Claude session history under
`~/.claude/projects/<encoded-cwd>` and the adapter continues the chosen session
with `--resume`. Codex threads resume with `exec resume --json <threadId> -`.

Pitfall: a `claude.cmd` whose target is missing does not fail to spawn. It exits
normally after printing `is not recognized as an internal or external command`,
and the adapter treats that stderr line as a spawn failure and kills the child,
so you see the real cause instead of an empty answer.

## Codex

Prerequisite: Codex CLI installed and logged in, with `codex --version`
working. A non-standard install path is supplied when the profile is created:

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\codex'
$env:LARK_CHANNEL_CODEX_BIN = 'C:\path\to\codex.cmd'
node .\dist\cli.js run --profile codex --agent codex --workspace C:\workspaces\codex
```

`LARK_CHANNEL_CODEX_BIN` (default `codex`) is read while the profile is created,
and the resolved absolute path is stored as `codex.binaryPath`; runs use the
stored path.

Per run the adapter builds, with the prompt on stdin and a trailing `-` as the
stdin sentinel:

```text
codex exec --json --sandbox <mode> \
  -c approval_policy="never" -c shell_environment_policy.inherit="all" \
  [--ignore-user-config] [--ignore-rules] --skip-git-repo-check -C <cwd> \
  [--image <path> ...] [--] -
```

A resumed run keeps the global flags first, then `resume --json <threadId>` and
the same stdin sentinel. In a fresh run the `--` separator before the sentinel
appears only when at least one image is passed. `--ignore-rules` is on by
default, so Codex ignores the user's rules files unless the profile sets
`ignoreRules: false`; `--ignore-user-config` is off by default, which is what
keeps `~/.codex/config.toml` in play. `CODEX_HOME` is left unset unless the
profile sets `codex.codexHome`, so Codex reuses the login under `~/.codex`. A
profile-local home is used only when `inheritCodexHome` is `false`.

Output is JSONL: `thread.started` yields the thread id, `agent_message` items
become text, `command_execution` items become tool_use/tool_result pairs whose
error flag follows the process exit code, and `turn.completed` carries usage. A
stream that ends without a terminal event is reported as a failure rather than
a silent success.

Codex is the only engine that accepts image attachments: accepted image files
become `--image` arguments, and no other adapter reads them. `/resume` lists
Codex threads by asking `<codex> app-server --listen stdio://` for recent
threads of the same working directory.

## Google Antigravity

Complete the `agy` login in a visible interactive PowerShell first; a background
bridge cannot answer a Google sign-in prompt. `test-agy-print.ps1` is the quick
check that the login works, since it runs a one-shot `agy --print` request:

```powershell
.\scripts\test-agy-print.ps1
```

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\antigravity'
$env:LARK_CHANNEL_ANTIGRAVITY_BIN = "$env:LOCALAPPDATA\agy\bin\agy.exe"
node .\dist\cli.js run --profile antigravity --agent antigravity --workspace C:\workspaces\antigravity
```

`LARK_CHANNEL_ANTIGRAVITY_BIN` is read while the profile is created and by
first-run detection. The default is `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows
when `LOCALAPPDATA` is set, and `agy` otherwise; the resolved path is stored as
`antigravity.binaryPath`. Detection has no `%LOCALAPPDATA%` fallback, so when
you rely on the default path either set the variable or pass an explicit
`--agent`.

The Antigravity adapter always uses the `agy` protocol. It never selects another
agent implementation from environment variables. Per run it builds:

```text
agy --input-format stream-json --output-format stream-json \
  --print-timeout <timeout> [--project <project>] [--model <model>] \
  [--dangerously-skip-permissions] [--sandbox] --add-dir <cwd>
```

The prompt is one `stream-json` envelope on stdin. The default `agy --print`
wait ceiling is 60 minutes, which is a leaked-process safety limit rather than a
normal task duration, and it can be overridden through
`antigravity.printTimeout`. Only `agent_response` step updates become text, and
a non-`SUCCESS` result status or an `error_message` step becomes the run error.
Antigravity does not provide dependable incremental text while researching or
building documents, so the bridge sends the final answer once as a normal reply
instead of opening a markdown stream. It does not post a synthetic
“received/working” message at intake; Feishu's native message state and the
bridge's common run-state mechanism apply equally to all Bots.

Antigravity is stateless: it has no session or thread identity, cannot resume,
and `/resume` reports that `agy --print` mode has no history. The run options
carry the resolved `permissions` values, but the adapter ignores them and passes
no permission flag derived from them. Permission behaviour comes from the
profile's `antigravity.dangerouslySkipPermissions` and `antigravity.sandbox`
fields, and profile creation sets `dangerouslySkipPermissions: true`.

The repository ships thin wrappers around this same profile: `run-antigravity-bridge.ps1`
runs it in the foreground, `start-antigravity-bridge-service.ps1` installs and
starts the OS daemon (`start`), `status-antigravity-bridge.ps1` reports it, and
`stop-antigravity-bridge-service.ps1` stops it. All four set
`LARK_CHANNEL_HOME` to `<repo>\.lark-channel`; the runner and the service
installer additionally set `LARK_CHANNEL_ANTIGRAVITY_BIN` to
`%LOCALAPPDATA%\agy\bin\agy.exe`, prepend `<repo>\bin` to `PATH`, set
`LARK_CHANNEL_DISABLE_PROXY=1`, and remove `HERMES_HOME` and
`HERMES_GIT_BASH_PATH`. Those two also load the current Windows user proxy
through `scripts\antigravity-proxy-env.ps1`, which sets `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY` and a loopback `NO_PROXY` only when the registry has
a proxy enabled and no proxy variable is already present.

## DeepSeek Harness

DeepSeek Harness has its own `deepseek-harness` agent kind and adapter. The
entry path is configuration for that adapter, not a mode switch on Antigravity.

Do not add an older DeepSeek or Antigravity bridge `bin` directory to this
Agent's `PATH`. The Pilot supplies one identity-neutral command directory after
all manifest environment overrides, and the adapter passes the current
profile's explicit lark-channel context. On startup, lark-cli binding is
accepted only when the current App is present in this profile's private target
file; a zero exit code that wrote another profile is a failed preflight.

Profile creation requires both `deepseekHarness.binaryPath` (the Node
executable) and `deepseekHarness.entryPath`. `LARK_CHANNEL_NODE_BIN` (default
`node`) and `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` supply them, and runs use the
stored values.

The repository scripts bootstrap, configure and start one profile called
`deepseek`:

```powershell
.\scripts\bootstrap-deepseek-bridge.ps1
.\scripts\setup-deepseek-feishu.ps1
.\scripts\start-deepseek-bridge-service.ps1
```

`bootstrap-deepseek-bridge.ps1` requires Node.js, Corepack and — unless
`-SkipHarness` is passed — Git. It runs `pnpm install --frozen-lockfile` and
`pnpm build` in this repository, clones `deepseek-harness` into
`vendor\deepseek-harness` when that checkout is missing, builds the CLI there,
and fails if `apps\cli\lib\bin.js` is absent.
`setup-deepseek-feishu.ps1` asks for the App ID and creates profile `deepseek`
with workspace `<repo>\workspace-deepseek` and
`LARK_CHANNEL_HOME=<repo>\.lark-channel-deepseek`.
`start-deepseek-bridge-service.ps1` reports the PID already recorded for profile
`deepseek` if that process is alive, and otherwise starts
`run-deepseek-bridge.ps1` as a hidden PowerShell host process: a detached
foreground bridge, not the Task Scheduler daemon. `status-deepseek-bridge.ps1`
lists the registry for that home, and `stop-deepseek-bridge-service.ps1` kills
every registered entry for the profile.

`deepseek-harness-env.ps1` is the shared setup those scripts dot-source. It
resolves the harness root from `DEEPSEEK_HARNESS_ROOT` or
`<repo>\vendor\deepseek-harness`, requires `apps\cli\lib\bin.js` to exist
there, and then exports `LARK_CHANNEL_NODE_BIN` (the resolved `node`),
`LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`, `LARK_CHANNEL_DISABLE_PROXY=1` and
`LARK_CHANNEL_HOME=<repo>\.lark-channel-deepseek`, prepends `<repo>\bin` to
`PATH`, and removes `LARK_CHANNEL_ANTIGRAVITY_BIN`, `HERMES_HOME` and
`HERMES_GIT_BASH_PATH` so two engines can never mix in one shell.

To use an existing checkout instead of the vendored clone:

```powershell
$env:DEEPSEEK_HARNESS_ROOT = 'D:\src\deepseek-harness'
.\scripts\bootstrap-deepseek-bridge.ps1 -SkipHarness
.\scripts\setup-deepseek-feishu.ps1
```

### The adapter imports the entry

The adapter does not run the entry as a program. It spawns

```text
node -e <bootstrap> <entryPath>
```

where the bootstrap buffers stdin, rewrites `process.argv` to
`[node, <entryPath>, '--profile', 'headless', <prompt>]` and only then
`await import(<entryPath>)`. The prompt therefore enters the harness as the
positional argument of a headless one-shot run rather than through stdin, and
Harness produces its answer as a final batch rather than a dependable
incremental stream. The bridge posts that completed answer once as a normal
topic reply and does not open an empty markdown stream or post a synthetic
intake acknowledgement.

This is the pitfall that matters most on this engine: a module whose only
dispatch is

```js
if (import.meta.main) await runCli();
```

does nothing when it is imported, because `import.meta.main` is true only when
that same file is the process entry module. Under the bridge the process entry
is the `-e` bootstrap. The official `@deepseek-ai/dsh` package ends its
`lib/bin.js` in exactly that shape, so pointing `entryPath` at it produces a run
that exits `0` with no output, which the bridge reports as an empty successful
run rather than as an error.

`deepseekHarness.entryPath` must therefore point at an entry module that
explicitly invokes the exported CLI after importing it:

```js
const mod = await import('<resolved>/node_modules/@deepseek-ai/dsh/lib/bin.js');
await mod.runCli();
```

`checkAvailability` also runs `node <entry> --version` with the entry as a main
module, so the shim must answer `--version` too. A bare guarded `lib/bin.js`
passes that check while still being unable to serve a run. Keep
`LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` (or the profile's `entryPath`) pointed at
your shim.

Output parsing is plain print: every stdout line becomes one text delta, with no
JSON, tool events or usage. The engine is stateless, so it never resumes, and no
sandbox or permission flag is passed at all.

## Hermes

This project does not install, update or reinstall Hermes. Collaboration copies
only `adapters\hermes\HOOK.yaml` and `handler.py` into the explicitly configured
`HERMES_HOME\hooks\feishu-collaboration-hub`. Stop removes only that Hook.
Hermes is not an `--agent` kind: it has no bridge adapter, and its launch command
comes entirely from the manifest.

Point the manifest launch command at the existing Hermes venv and
`python.exe -m hermes_cli.main gateway run`. An `agents[]` entry that enables
`hermesHook` also needs `hermesHook.home`; Pilot uses that home for the Hook
directory, and it reuses `original.start.filePath` as the Python interpreter for
its `hermes gateway status` probe, so a detached Hermes gateway stays visible in
status output after its short-lived launcher exits.

The Hook accepts a human group message only when Hermes was actually mentioned.
For bot-originated messages it additionally requires a pending Hub dispatch for
the same topic. During an authorized run Hermes receives the current agent
directory and the same `collab-delegate ask|handoff` command contract as the
Node bridges, so every maintained bot can delegate to every other bot. The Hook
acks the dispatch as accepted, then records and completes or fails that exact
dispatch when the run ends.

For a shared collaboration group, use Hermes's group-chat boundary rather than
a per-person allowlist: set `FEISHU_GROUP_POLICY=open`, keep
`FEISHU_ALLOWED_USERS` empty, and set `FEISHU_GROUP_ALLOWED_CHATS` to the
approved Feishu `oc_...` chat IDs. All members of those groups can then
@mention Fool. Messages from other groups and direct messages remain outside
that authorization grant. This requires the installed Hermes Feishu adapter to
provide `FEISHU_GROUP_ALLOWED_CHATS` support.

## Collaboration Manifest

Run `Setup-CollabPilot.ps1`, then edit `.runtime\pilot.local.json`:

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
```

Each `agents[]` entry needs at least:

- `id`, `displayName`, `aliases`;
- the real `launch.filePath`, `arguments`, `workingDirectory`;
- the `launch.environment` its own profile needs;
- optional `original.stop/start` for lossless switching and rollback;
- `hermesHook`, only for Hermes.

DeepSeek example:

```json
{
  "id": "chariot",
  "displayName": "Chariot",
  "aliases": ["deepseek"],
  "enabled": true,
  "launch": {
    "filePath": "node.exe",
    "arguments": [
      "${REPO_ROOT}\\dist\\cli.js", "run",
      "--profile", "deepseek", "--agent", "deepseek-harness",
      "--workspace", "C:\\workspaces\\deepseek"
    ],
    "workingDirectory": "C:\\workspaces\\deepseek",
    "environment": {
      "LARK_CHANNEL_HOME": "C:\\feishu-profiles\\deepseek",
      "LARK_CHANNEL_NODE_BIN": "node.exe",
      "LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY": "C:\\feishu-profiles\\deepseek\\dsh-entry.mjs"
    }
  }
}
```

Point `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` at an entry module that runs when it
is imported, as described above, and not at a package file guarded by
`import.meta.main`. Validate with `Test-CollabPilotConfig.ps1`, then start the
group. See [Windows operations](./WINDOWS_OPERATIONS.md) for every field and
rollback.
