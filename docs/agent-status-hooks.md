# AI Agent Status Hooks

FocuSD can mirror Codex, Claude Code, ZCode, and DSH (DeepSeek Harness) task activity on the collapsed island status light:

- running task: red
- completed, idle, or no task: green
- failed task, or a running marker older than 10 minutes without a stop event: yellow

Do not use process or CPU detection for this integration. Codex and Claude Code can stay alive while idle, and Claude Code may run inside a VSCode terminal. The reliable path is to wire into lifecycle hooks.

## Supported Agents And Their Hook Files

| Agent | Hook config written by the installer |
| --- | --- |
| Codex | `%USERPROFILE%\.codex\config.toml` |
| Claude Code | `%USERPROFILE%\.claude\settings.json` |
| ZCode | `%USERPROFILE%\.zcode\cli\config.json` |
| DSH (DeepSeek Harness) | `dsh-hooks` plugin plus a managed block in `~/.dsh/profiles/<profile>/cordis.patch.yml` for every installed profile |

ZCode uses `UserPromptSubmit` (running) and `Stop` (completed) hooks in the `hooks.events` section of `~/.zcode/cli/config.json`, with `hooks.enabled` set to `true` — configuration-file hooks are disabled by default in ZCode.

DSH has no native hook config yet, so the installer uses the community [`dsh-hooks`](https://github.com/PeterBon/dsh-hooks) plugin: it runs `dsh plugin --profile <name> add dsh-hooks` (requires the `dsh` CLI on `PATH` and network access for the first install) and then appends a managed `fly-island-agent-status` block mapping `turn/start` to running and `turn/end` (`completed` / `aborted` / `error`) to completed/failed. If a profile already contains a custom `dsh-hooks` entry, the installer skips it and reports the profile so you can merge the hooks manually. Restart DSH sessions after installing.

## User Setup

For release users and source builds, use the in-app installer:

1. Open FocuSD Island.
2. Expand the island and open Settings.
3. In **AI Agent 状态灯**, click **安装/修复**.
4. Restart Codex, ZCode, DSH, and any VSCode terminal running Claude Code.
5. For Codex, review and trust the new hooks when Codex prompts you, or use `/hooks`.

The installer writes the hook scripts to the current user's app data directory:

```text
%APPDATA%\com.focusd.island\
```

It then updates:

```text
%USERPROFILE%\.codex\config.toml
%USERPROFILE%\.claude\settings.json
%USERPROFILE%\.zcode\cli\config.json
~/.dsh/profiles/<profile>/cordis.patch.yml
```

The operation is repeatable. Running **安装/修复** again rewrites FocuSD's managed hooks to the current app-data script path and removes older FocuSD hook entries that referenced development paths such as `D:\FocuSD\scripts`.

## Runtime Contract

Prompt submission uses a fast marker file instead of PowerShell JSON work:

```text
agent-codex-running.flag
agent-claudeCode-running.flag
agent-zcode-running.flag
agent-dsh-running.flag
```

FocuSD polls these marker files every 200ms. If any marker exists and is fresh, the island turns red. If a marker is still present after 10 minutes, FocuSD treats it as stale and turns the island yellow instead of leaving the user waiting on a permanent red light.

When the turn finishes, `focusd-agent-status.ps1` removes the marker, writes `agent-status.json`, and keeps a short hold marker when the task completed too quickly. This makes very short prompts still visibly flash red for about 800ms.

`agent-status.json` uses this shape:

```json
{
  "codex": {
    "phase": "running",
    "taskId": "optional-id",
    "updatedAt": 1783584000000
  },
  "claudeCode": {
    "phase": "completed",
    "taskId": "optional-id",
    "updatedAt": 1783584000000
  },
  "zcode": {
    "phase": "idle",
    "updatedAt": 1783584000000
  },
  "dsh": {
    "phase": "failed",
    "updatedAt": 1783584000000
  },
  "updatedAt": 1783584000000
}
```

`phase === "running"` turns the light red. `phase === "failed"` turns the light yellow. Missing files, invalid JSON, missing fields, unknown phases, `idle`, and `completed` are treated as green states. A derived `stale` phase is returned by the app when a running marker remains for more than 10 minutes without a later status update.

## Manual Smoke Test

After using the in-app installer, run these commands with the app-data scripts:

```powershell
$dir = Join-Path $env:APPDATA 'com.focusd.island'
& "$dir\focusd-agent-running.cmd" codex
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\focusd-agent-status.ps1" codex completed

& "$dir\focusd-agent-running.cmd" claudeCode
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\focusd-agent-status.ps1" claudeCode completed

powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\focusd-agent-status.ps1" claudeCode failed

& "$dir\focusd-agent-running.cmd" zcode
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\focusd-agent-status.ps1" zcode completed

& "$dir\focusd-agent-running.cmd" dsh
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\focusd-agent-status.ps1" dsh failed
```

Expected behavior:

- The island turns red after the `focusd-agent-running.cmd` command.
- The island returns green after the `focusd-agent-status.ps1 ... completed` command.
- The island turns yellow after the `focusd-agent-status.ps1 ... failed` command and returns green after clearing that status from the app.

## Notes For Manual Configuration

Manual configuration is usually unnecessary. Prefer the in-app installer because it uses the user's actual app-data path and handles Claude Code's Windows command behavior.

If you do edit Claude Code hooks manually on Windows, prefer Claude Code's exec form: put `cmd.exe` or `powershell.exe` in `command` and pass every argument through `args`. This avoids shell-selection differences between VSCode, Git Bash, PowerShell, and `cmd.exe`.
