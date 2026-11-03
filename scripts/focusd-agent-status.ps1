param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("codex", "claudeCode", "zcode", "dsh")]
  [string]$Provider,

  [Parameter(Mandatory = $true, Position = 1)]
  [ValidateSet("idle", "running", "completed", "failed")]
  [string]$Phase,

  [Parameter(Position = 2)]
  [string]$TaskId = "",

  [string]$StatusPath = "",

  [int]$MinimumRunningVisibleMs = 800,

  [switch]$HookResponse
)

$ErrorActionPreference = "Stop"

function New-AgentTaskStatus {
  param(
    [string]$Phase = "idle",
    [string]$TaskId = "",
    [long]$UpdatedAt = 0,
    [string]$Message = ""
  )

  $status = [ordered]@{
    phase = $Phase
    updatedAt = $UpdatedAt
  }

  if ($TaskId) {
    $status.taskId = $TaskId
  }

  if ($Message) {
    $status.message = $Message
  }

  return $status
}

function Copy-AgentTaskStatus {
  param(
    [object]$Source
  )

  if ($null -eq $Source) {
    return New-AgentTaskStatus
  }

  $phase = "idle"
  if ($Source.PSObject.Properties.Name -contains "phase") {
    $candidatePhase = [string]$Source.phase
    if (@("idle", "running", "completed", "failed") -contains $candidatePhase) {
      $phase = $candidatePhase
    }
  }

  $updatedAt = 0
  if ($Source.PSObject.Properties.Name -contains "updatedAt") {
    $updatedAt = [long]$Source.updatedAt
  }

  $taskId = ""
  if ($Source.PSObject.Properties.Name -contains "taskId") {
    $taskId = [string]$Source.taskId
  }

  $message = ""
  if ($Source.PSObject.Properties.Name -contains "message") {
    $message = [string]$Source.message
  }

  return New-AgentTaskStatus -Phase $phase -TaskId $taskId -UpdatedAt $updatedAt -Message $message
}

function Get-TruncatedText {
  param(
    [string]$Text,
    [int]$MaxLength = 900
  )

  if (-not $Text) {
    return ""
  }

  $normalized = $Text -replace "(\r?\n\s*){3,}", "`n`n"
  $normalized = $normalized.Trim()
  if (-not $normalized) {
    return ""
  }

  if ($normalized.Length -gt $MaxLength) {
    return $normalized.Substring(0, $MaxLength) + "..."
  }

  return $normalized
}

function Get-MessageFromTranscript {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
    return ""
  }

  try {
    $lines = Get-Content -LiteralPath $Path -Tail 40 -Encoding UTF8 -ErrorAction Stop
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      $line = $lines[$i]
      if (-not $line -or $line.Length -gt 2000000) {
        continue
      }
      try {
        $entry = $line | ConvertFrom-Json
      } catch {
        continue
      }
      if ($entry.type -ne "assistant") {
        continue
      }
      $blocks = $entry.message.content
      if ($blocks -is [string]) {
        return $blocks
      }
      $texts = @($blocks | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text })
      if ($texts.Count -gt 0) {
        return ($texts -join "`n")
      }
    }
  } catch {
  }

  return ""
}

function Read-TranscriptTailLines {
  param(
    [string]$Path,
    [int]$TailBytes = 524288
  )

  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $length = $stream.Length
    if ($length -le 0) {
      return @()
    }

    $start = [Math]::Max(0, $length - $TailBytes)
    $stream.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
    $buffer = New-Object byte[] ($length - $start)
    $read = $stream.Read($buffer, 0, $buffer.Length)
  } finally {
    $stream.Dispose()
  }

  if ($read -le 0) {
    return @()
  }

  $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  $lines = $text -split "`n"
  if ($start -gt 0 -and $lines.Count -gt 1) {
    # The first line starts mid-record when the read began inside the file.
    $lines = $lines[1..($lines.Count - 1)]
  }

  return $lines
}

function Get-MessageFromZcodeRollout {
  param([string]$SessionId)

  if (-not $SessionId) {
    return ""
  }

  $clean = $SessionId -replace "^(session_|sess_)", ""
  if (-not $clean) {
    return ""
  }

  $dir = Join-Path $env:USERPROFILE ".zcode\cli\rollout"
  if (-not (Test-Path -LiteralPath $dir)) {
    return ""
  }

  $files = Get-ChildItem -LiteralPath $dir -Filter "model-io-*$clean*.jsonl" -ErrorAction SilentlyContinue
  if (-not $files -or $files.Count -eq 0) {
    return ""
  }

  $file = $files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  try {
    # Read only the tail bytes of the transcript. Windows PowerShell 5.1 reads
    # the whole file for Get-Content -Tail, which took ~44s on a 54MB session
    # log and made the Stop hook hit its 10s timeout, leaving the running marker
    # behind so the island kept showing a running task after the turn ended.
    $lines = Read-TranscriptTailLines -Path $file.FullName -TailBytes 524288
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      $line = $lines[$i]
      if (-not $line -or $line.Length -gt 4000000) {
        continue
      }
      try {
        $entry = $line | ConvertFrom-Json
      } catch {
        continue
      }
      $response = $entry.response
      if (-not $response) {
        continue
      }
      $text = [string]$response.text
      if ($text) {
        return $text
      }
    }
  } catch {
  }

  return ""
}

function Get-HookInputText {
  param([string]$Phase)

  $probe = @{
    Text = ""
    Raw = ""
    SessionId = ""
  }

  if (-not [Console]::IsInputRedirected) {
    return $probe
  }

  # Read raw bytes and decode UTF-8 explicitly: [Console]::In would decode
  # with the legacy console codepage (GBK on zh-CN Windows) and corrupt
  # non-ASCII agent content.
  try {
    $stream = [Console]::OpenStandardInput()
    $memory = New-Object System.IO.MemoryStream
    $buffer = New-Object byte[] 4096
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $memory.Write($buffer, 0, $read)
    }
    $raw = [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
    $memory.Dispose()
  } catch {
    return $probe
  }

  if (-not $raw) {
    return $probe
  }

  $raw = $raw.Trim()
  if (-not $raw) {
    return $probe
  }

  $probe.Raw = $raw

  try {
    $payload = $raw | ConvertFrom-Json
  } catch {
    return $probe
  }

  if (-not $payload) {
    return $probe
  }

  $names = $payload.PSObject.Properties.Name
  if ($Phase -eq "running" -and $names -contains "prompt") {
    $probe.Text = [string]$payload.prompt
  }
  if (-not $probe.Text -and $names -contains "transcript_path") {
    $probe.Text = Get-MessageFromTranscript -Path ([string]$payload.transcript_path)
  }
  if ($names -contains "session_id") {
    $probe.SessionId = [string]$payload.session_id
  }

  return $probe
}

function Get-DefaultStatusPath {
  if ($env:FOCUSD_AGENT_STATUS_PATH) {
    return $env:FOCUSD_AGENT_STATUS_PATH
  }

  if ($env:APPDATA) {
    return Join-Path $env:APPDATA "com.focusd.island\agent-status.json"
  }

  return Join-Path $env:LOCALAPPDATA "com.focusd.island\agent-status.json"
}

function Get-AgentMarkerNames {
  param(
    [string]$Provider
  )

  if ($Provider -eq "codex") {
    return @{
      Running = "agent-codex-running.flag"
      Hold = "agent-codex-running-hold.flag"
    }
  }

  if ($Provider -eq "zcode") {
    return @{
      Running = "agent-zcode-running.flag"
      Hold = "agent-zcode-running-hold.flag"
    }
  }

  if ($Provider -eq "dsh") {
    return @{
      Running = "agent-dsh-running.flag"
      Hold = "agent-dsh-running-hold.flag"
    }
  }

  return @{
    Running = "agent-claudeCode-running.flag"
    Hold = "agent-claudeCode-running-hold.flag"
  }
}

function Update-AgentRunningMarkers {
  param(
    [string]$Provider,
    [string]$Phase,
    [string]$StatusDirectory,
    [long]$Now,
    [int]$MinimumRunningVisibleMs
  )

  $markerNames = Get-AgentMarkerNames -Provider $Provider
  $runningPath = Join-Path $StatusDirectory $markerNames.Running
  $holdPath = Join-Path $StatusDirectory $markerNames.Hold

  if ($Phase -eq "running") {
    [System.IO.File]::WriteAllText($runningPath, "", [System.Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $holdPath -Force -ErrorAction SilentlyContinue
    return
  }

  $visibleUntil = 0
  if (Test-Path -LiteralPath $runningPath) {
    $markerUpdatedAt = [DateTimeOffset](Get-Item -LiteralPath $runningPath).LastWriteTimeUtc
    $elapsedMs = [Math]::Max(0, $Now - $markerUpdatedAt.ToUnixTimeMilliseconds())
    $remainingMs = [Math]::Max(0, $MinimumRunningVisibleMs - $elapsedMs)
    if ($remainingMs -gt 0) {
      $visibleUntil = $Now + $remainingMs
    }
  }

  Remove-Item -LiteralPath $runningPath -Force -ErrorAction SilentlyContinue
  if ($visibleUntil -gt $Now) {
    [System.IO.File]::WriteAllText($holdPath, [string]$visibleUntil, [System.Text.UTF8Encoding]::new($false))
  } else {
    Remove-Item -LiteralPath $holdPath -Force -ErrorAction SilentlyContinue
  }
}

if (-not $StatusPath) {
  $StatusPath = Get-DefaultStatusPath
}

# Content capture: DSH hands over the turn text via DSH_HOOK_* environment
# variables; command hooks (ZCode, Claude Code, Codex) receive a JSON payload
# on stdin (prompt / transcript_path / session_id).
$message = ""
if ($Provider -eq "dsh" -and $env:DSH_HOOK_CONTENT) {
  $message = Get-TruncatedText -Text $env:DSH_HOOK_CONTENT
}

$hookInput = Get-HookInputText -Phase $Phase
if (-not $message -and $hookInput.Text) {
  $message = Get-TruncatedText -Text $hookInput.Text
}

if (-not $message -and $Phase -ne "running") {
  $sessionId = ""
  if ($env:CLAUDE_SESSION_ID) {
    $sessionId = $env:CLAUDE_SESSION_ID
  } elseif ($hookInput.SessionId) {
    $sessionId = $hookInput.SessionId
  }
  if ($sessionId) {
    $message = Get-TruncatedText -Text (Get-MessageFromZcodeRollout -SessionId $sessionId)
  }
}

$mutex = New-Object System.Threading.Mutex($false, "FocuSD.AgentStatus")
$hasLock = $false

try {
  $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds(5))
  if (-not $hasLock) {
    throw "Timed out waiting for the FocuSD agent status file lock."
  }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $state = [ordered]@{
    codex = New-AgentTaskStatus
    claudeCode = New-AgentTaskStatus
    zcode = New-AgentTaskStatus
    dsh = New-AgentTaskStatus
    updatedAt = $now
  }

  if (Test-Path -LiteralPath $StatusPath) {
    try {
      $existing = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
      $state.codex = Copy-AgentTaskStatus -Source $existing.codex
      $state.claudeCode = Copy-AgentTaskStatus -Source $existing.claudeCode
      $state.zcode = Copy-AgentTaskStatus -Source $existing.zcode
      $state.dsh = Copy-AgentTaskStatus -Source $existing.dsh
    } catch {
      $state.codex = New-AgentTaskStatus
      $state.claudeCode = New-AgentTaskStatus
      $state.zcode = New-AgentTaskStatus
      $state.dsh = New-AgentTaskStatus
    }
  }

  $nextTask = New-AgentTaskStatus -Phase $Phase -TaskId $TaskId -UpdatedAt $now -Message $message
  switch ($Provider) {
    "codex" { $state.codex = $nextTask }
    "claudeCode" { $state.claudeCode = $nextTask }
    "zcode" { $state.zcode = $nextTask }
    "dsh" { $state.dsh = $nextTask }
  }
  $state.updatedAt = $now

  $statusDirectory = Split-Path -Parent $StatusPath
  New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
  Update-AgentRunningMarkers -Provider $Provider -Phase $Phase -StatusDirectory $statusDirectory -Now $now -MinimumRunningVisibleMs $MinimumRunningVisibleMs

  $json = $state | ConvertTo-Json -Depth 5
  $temporaryPath = "$StatusPath.tmp"
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($temporaryPath, $json, $utf8NoBom)
  Move-Item -LiteralPath $temporaryPath -Destination $StatusPath -Force
} finally {
  if ($hasLock) {
    $mutex.ReleaseMutex() | Out-Null
  }
  $mutex.Dispose()
}

# Diagnostics: keep the latest unrecognized hook payload so stdin-schema
# problems can be diagnosed without attaching a debugger.
if (-not $message -and $hookInput.Raw) {
  $debugPath = Join-Path (Split-Path -Parent $StatusPath) "agent-last-hook-input.txt"
  $snippet = $hookInput.Raw
  if ($snippet.Length -gt 8192) {
    $snippet = $snippet.Substring(0, 8192)
  }
  try {
    [System.IO.File]::WriteAllText($debugPath, $snippet, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
  }
}

if ($HookResponse) {
  [Console]::Out.Write('{"continue":true,"suppressOutput":true}')
}
