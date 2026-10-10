param([string]$Verb = '', [int]$Ttl = 60, [string]$Device = 'Win', [string]$Shared = '')
# 标题栏计数（counter.cs）的启动器：插件在会话启动 / 连上时调它，同一时间只留一个。
#
#   powershell -File counter.ps1 start <缓存分钟数> <本机标签> [共享目录]
#   powershell -File counter.ps1 stop
#   powershell -File counter.ps1 run   <缓存分钟数> <本机标签> [共享目录]    （start 拉起的那个进程自己用）
#
# start：已经有一个同一份 counter.ps1 在跑就什么都不做；在跑的是别的版本（插件升级了）就先停掉它。
#        新的计数用 Start-Process 另起（窗口隐藏）：启动器跑完就退，计数不再是谁的子进程，会话关了它照样在。
# stop： 停掉在跑的计数（设置项 menuBar 关掉时）。
# run：  当场编译 counter.cs，pid 写进 ~/.claude/task-board-counter.pid，跑起来。
# 共享目录放最后：Windows PowerShell 5.1 用 -File 传空字符串参数会被吞掉，空 = 不传。
$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $env:USERPROFILE '.claude\task-board-counter.pid'
$self = $PSCommandPath

# 在跑的计数：@{ pid; cmd }；没有 = $null
function Get-Running {
  try { $p = ([System.IO.File]::ReadAllText($pidPath)).Trim() } catch { return $null }
  if ($p -notmatch '^\d+$') { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.CommandLine -notmatch 'counter\.ps1"?\s+run\b') { return $null }
  return @{ pid = [int]$p; cmd = $proc.CommandLine }
}

function Stop-Running {
  $r = Get-Running
  if ($r) { Stop-Process -Id $r.pid -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

switch ($Verb) {
  'stop' { Stop-Running; 'stopped'; exit 0 }
  'start' {
    $r = Get-Running
    if ($r) {
      # 同一份脚本在跑：不动（命令行里含脚本的完整路径，路径里有版本号）
      if ($r.cmd.IndexOf($self, [StringComparison]::OrdinalIgnoreCase) -ge 0) { 'running'; exit 0 }
      Stop-Running
    }
    $argv = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File `"$self`" run $Ttl `"$Device`""
    if ($Shared) { $argv += " `"$Shared`"" }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argv -WindowStyle Hidden | Out-Null
    'started'; exit 0
  }
  'run' {
    [System.IO.File]::WriteAllText($pidPath, "$PID")
    Add-Type -Path (Join-Path $PSScriptRoot 'counter.cs') -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions
    [TaskBoardCounter.App]::Run((Join-Path $PSScriptRoot 'scan.ps1'), $Ttl, $Shared, $Device)
    exit 0
  }
  default { 'usage: counter.ps1 start <ttl> <device> [shared] | stop'; exit 2 }
}
