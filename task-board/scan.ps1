param([switch]$Once, [switch]$LeadOnly, [int]$Hours = 24, [int]$Max = 12, [int]$IntervalMs = 3000, [string]$Shared = '', [string]$Device = '')
# 增量扫描 ~/.claude/projects 下各会话的 transcript，每轮输出一行 JSON。
#   -Shared DIR  跨设备共享目录（同步盘里）：每 10 秒把本机快照写成 DIR\<Device>.json，每轮读目录里其他电脑的快照附在 remote 里
#   -Device NAME 本机标签（卡片上的灰色小标签，也是共享目录里的文件名；空 = Win）
#   -LeadOnly    只当主扫描：已经有主扫描在跑就输出一行 {"follow":"<主扫描的输出文件>"} 后退出，调用方自己去读那个文件（不再挂一个进程转发）
$ErrorActionPreference = 'SilentlyContinue'
$root = Join-Path $env:USERPROFILE '.claude\projects'
# 全局开关（所有会话共用）：任务板上按一下就改这个文件，各会话的扫描进程每轮都重读
$prefsPath = Join-Path $env:USERPROFILE '.claude\task-board-prefs.json'
# 账号用量（5 小时 / 每周额度）：哪个会话拿到新读数就写这里，扫描进程原样转给所有会话
$usagePath = Join-Path $env:USERPROFILE '.claude\task-board-usage.json'
# iPhone Live 推送器的配置：本机有它，任务板上才画「iPhone Live」开关（开关存在 prefs 的 liveActivity，推送器读同一个文件）
$livePath = Join-Path $env:USERPROFILE '.claude\task-board-live.json'
# “在等我决定”的标记：每个会话一个文件（文件名 = 会话 id，内容 = 标记时间毫秒，空 = 没在等）
$inputDir = Join-Path $env:USERPROFILE '.claude\task-board-input'
New-Item -ItemType Directory -Force $inputDir | Out-Null
# 最近一轮的输出（所有会话共用）：新开的会话先显示它，不用等自己的扫描进程读完所有 transcript
$snapPath = Join-Path $env:USERPROFILE '.claude\task-board-snapshot.json'
$lastSnap = [datetime]::MinValue
# 跨设备共享：本机标签（用户每台机器各设一个，默认 Win）和系统；共享目录开头的 ~ = 用户主目录
$os = 'win'
if (-not $Device) { $Device = 'Win' }
if ($Shared -match '^~([\\/]|$)') { $Shared = Join-Path $env:USERPROFILE $Shared.Substring(2) }
if ($Shared) {
  New-Item -ItemType Directory -Force $Shared | Out-Null
  if (-not (Test-Path -LiteralPath $Shared -PathType Container)) { $Shared = '' }   # 建不出来（同步盘没装）就当没开
}
# 共享目录里的快照超过这么久没更新 = 那台电脑离线，不显示（和插件里的 SNAP_MAX_SEC 一致）
$SHARED_MAX_MS = 10 * 60 * 1000
# 一台电脑只让一个扫描进程真扫：App 让最近打开过的会话都在后台挂着，每个会话（还有标题栏计数、推送器）各起一个扫描进程。
# 参数一样的进程共用一把锁：拿到锁的是主扫描，每轮把输出也写进本机文件；其他的每轮先试一次拿锁，拿不到就转发那个文件。
# 锁是不共享打开的文件句柄，进程退出系统自动放锁，下一个进程这一轮就接手。-Once（测试）不排队，直接扫。
$sharedKey = if ($Shared) { [System.IO.Path]::GetFullPath($Shared).TrimEnd('\').ToLowerInvariant() } else { '' }
$md5 = [System.Security.Cryptography.MD5]::Create()
$scanId = -join ($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$Hours|$Max|$sharedKey|$Device")) | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') })
$lockPath = Join-Path $env:USERPROFILE ".claude\task-board-scan-$scanId.lock"
$fwdPath = Join-Path $env:USERPROFILE ".claude\task-board-scan-$scanId.json"
$lockFs = $null
function Try-Lock {
  try { $script:lockFs = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); return $true } catch { return $false }
}
$files = @{}   # path -> 增量状态
$utf8 = New-Object System.Text.UTF8Encoding($false)
$rxId = [regex]'"id":"(msg_[^"]+)"'
$rxUsage = [regex]'"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+),"output_tokens":(\d+)'
$rxKind = [regex]'"type":"(assistant|user)","uuid"'
$rxStop = [regex]'"stop_reason":"([a-z_]+)"'
$rxTitle = [regex]'"customTitle":"((?:[^"\\]|\\.)*)"'
$rxPrompt = [regex]'"lastPrompt":"((?:[^"\\]|\\.)*)"'
$rxCwd = [regex]'"cwd":"((?:[^"\\]|\\.)*)"'
$rxTs = [regex]'"timestamp":"([^"]+)"'
$rxTaskUpd = [regex]'"name":"TaskUpdate","input":\{[^}]*?"taskId":"(\d+)"[^}]*?"status":"([a-z_]+)"'
$rxModel = [regex]'"model":"(claude-[^"]+)"'
$rxTool = [regex]'"type":"tool_use","id":"[^"]*","name":"([^"]+)"'
$rxEffort = [regex]'"effort":"([a-z]+)"'
# 派到后台的活（后台命令、后台子代理、Workflow）：工具结果里的编号；完成通知里带同一个编号和结束状态。Monitor 只是盯着，不算
$rxBgCmd = [regex]'"backgroundTaskId":"([A-Za-z0-9_-]+)"'
$rxBgAsync = [regex]'"(?:agentId|taskId)":"([A-Za-z0-9_-]+)"'
$rxBgDone = [regex]'<task-id>([A-Za-z0-9_-]+)</task-id>(?:(?!</task-notification>).)*?<status>(?:completed|failed|killed|stopped)</status>'
# 要我答了才继续的工具：提问、计划审批、“开新会话 / 在这里做”卡片（start_session 的 offer）
$rxWaitTool = [regex]'"type":"tool_use","id":"([^"]+)","name":"(AskUserQuestion|ExitPlanMode|mcp__ccd_session__start_session)"'
# 后台的活和“在等我”的工具超过这么久还没结果就不算了（会话被关掉、App 重启时不会有完成通知）
$PENDING_MAX_H = 6

function Unesc([string]$s) { try { return [regex]::Unescape($s) } catch { return $s } }

# 超过 MAX_PATH 的路径加 \\?\ 前缀（Windows PowerShell 5.1 / .NET Framework 默认不认长路径）
function LongPath([string]$p) {
  if ($p.Length -ge 240 -and -not $p.StartsWith('\\?\')) { return '\\?\' + $p }
  return $p
}

function New-FileState {
  @{ offset = 0L; msgs = @{}; tin = 0L; tcw = 0L; tcr = 0L; tout = 0L
     title = ''; prompt = ''; cwd = ''; kind = ''; stop = ''; todos = $null; tasks = [ordered]@{}; taskN = 0
     lastReq = $null    # 最后一次 API 请求的时间（UTC），用来算提示缓存还剩多久
     # 步骤计时：任务 / todo 变成 in_progress 和 completed 的时间；todoT 按 todo 内容记
     todoT = @{}; lastDone = $null
     turnAt = $null     # 这一轮用户提问的时间（没有任务清单时的总耗时从这里算）
     bg = @{}           # 还在后台跑的活：编号 -> 派出去的时间（UTC）
     waitId = ''; waitAt = $null   # 还没答的提问 / 计划审批 / 开新会话卡片：工具调用 id 和时间
     model = ''; tool = ''; firstTs = $null; lastTs = $null; effort = ''; calls = 0 }   # 子代理行用
}

# 一个步骤变状态时记时间：in_progress 记开始，completed 记结束（没见过开始就用上一步结束的时间）
function Mark-Step($st, $t, [string]$s, $ts) {
  if (-not $ts) { return }
  if ($s -eq 'in_progress' -and -not $t.a) { $t.a = $ts }
  elseif ($s -eq 'completed' -and -not $t.e) {
    if (-not $t.a) { $t.a = if ($st.lastDone -and $st.lastDone -ge $t.c) { $st.lastDone } else { $t.c } }
    $t.e = $ts; $st.lastDone = $ts
  }
}

# 桌面版自己的任务清单（mcp__ccd_turn__update_plan）放进同一份 tasks：
#   items = 整份清单（同名的步骤留着原来的计时）；advance = 当前这步做完、下一个没开始的开始；done / start = 按 1 起的序号
function Apply-Plan($st, $in, $ts) {
  if (-not $in) { return }
  if ($in.items) {
    $prev = @{}; foreach ($t in $st.tasks.Values) { $prev[[string]$t.t] = $t }
    $st.tasks.Clear(); $n = 0
    foreach ($it in @($in.items)) {
      $n++; $title = [string]$it.content
      $t = $prev[$title]; if (-not $t) { $t = @{ s = 'pending'; t = $title; c = $ts; a = $null; e = $null } }
      $t.s = [string]$it.status; Mark-Step $st $t $t.s $ts
      $st.tasks["$n"] = $t
    }
    $st.taskN = $n
    return
  }
  $list = @($st.tasks.Values)
  if ($in.advance) {
    $cur = -1; for ($i = 0; $i -lt $list.Count; $i++) { if ($list[$i].s -eq 'in_progress') { $cur = $i; break } }
    if ($cur -ge 0) { $list[$cur].s = 'completed'; Mark-Step $st $list[$cur] 'completed' $ts }
    for ($i = $cur + 1; $i -lt $list.Count; $i++) { if ($list[$i].s -eq 'pending') { $list[$i].s = 'in_progress'; Mark-Step $st $list[$i] 'in_progress' $ts; break } }
  }
  foreach ($d in @($in.done)) { if ($null -eq $d) { continue }; $i = [int]$d - 1; if ($i -ge 0 -and $i -lt $list.Count) { $list[$i].s = 'completed'; Mark-Step $st $list[$i] 'completed' $ts } }
  if ($in.start) { $i = [int]$in.start - 1; if ($i -ge 0 -and $i -lt $list.Count) { $list[$i].s = 'in_progress'; Mark-Step $st $list[$i] 'in_progress' $ts } }
}

function Read-New($path, $st) {
  $fs = [System.IO.File]::Open((LongPath $path), 'Open', 'Read', 'ReadWrite')
  try {
    if ($fs.Length -lt $st.offset) { $st.offset = 0L }   # 文件被重写
    $len = $fs.Length - $st.offset
    if ($len -le 0) { return }
    $fs.Seek($st.offset, 'Begin') | Out-Null
    $buf = New-Object byte[] $len
    $read = 0
    while ($read -lt $len) { $n = $fs.Read($buf, $read, $len - $read); if ($n -le 0) { break }; $read += $n }
    $last = [Array]::LastIndexOf($buf, [byte]10, $read - 1)
    if ($last -lt 0) { return }                            # 还没有完整的一行
    $st.offset += $last + 1
    $text = $utf8.GetString($buf, 0, $last)
  } finally { $fs.Dispose() }

  foreach ($line in $text.Split("`n")) {
    if ($line.Length -lt 2) { continue }
    # 时间戳就地解析（每行都要走一遍，PowerShell 调函数的开销比解析本身还大）
    $lts = $null
    $tm = $rxTs.Match($line)
    if ($tm.Success) { $lts = ([datetime]::Parse($tm.Groups[1].Value, $null, 'RoundtripKind')).ToUniversalTime() }
    if ($lts) { if (-not $st.firstTs) { $st.firstTs = $lts }; $st.lastTs = $lts }
    # 用户亲手发的提问 = 新一轮开始（工具结果、系统附带的消息没有这个标记）
    if ($line.IndexOf('"origin":{"kind":"human"}', [StringComparison]::Ordinal) -ge 0) {
      if ($lts) { $st.turnAt = $lts }
      $st.waitId = ''   # 我发了话 = 上一轮问我的已经答了
    }
    # 派到后台：Bash 的 backgroundTaskId，子代理 / Workflow 的 async_launched（只看 toolUseResult 里没转义的字段）
    $tr = $line.IndexOf('"toolUseResult":{', [StringComparison]::Ordinal)
    if ($tr -ge 0) {
      $rest = $line.Substring($tr)
      $bm = $rxBgCmd.Match($rest)
      if (-not $bm.Success -and $rest.IndexOf('"status":"async_launched"', [StringComparison]::Ordinal) -ge 0) { $bm = $rxBgAsync.Match($rest) }
      if ($bm.Success) { $st.bg[$bm.Groups[1].Value] = if ($lts) { $lts } else { [datetime]::UtcNow } }
    }
    if ($st.bg.Count -gt 0 -and $line.IndexOf('<task-id>', [StringComparison]::Ordinal) -ge 0) {
      foreach ($dm in $rxBgDone.Matches($line)) { $st.bg.Remove($dm.Groups[1].Value) }
    }
    if ($st.waitId -and $line.IndexOf("`"tool_use_id`":`"$($st.waitId)`"", [StringComparison]::Ordinal) -ge 0) { $st.waitId = '' }
    $k = $rxKind.Match($line)
    if ($k.Success) {
      $st.kind = $k.Groups[1].Value
      if ($st.kind -eq 'assistant') {
        $mm = $rxModel.Match($line); if ($mm.Success) { $st.model = $mm.Groups[1].Value }
        $tl = $rxTool.Matches($line); if ($tl.Count -gt 0) { $st.tool = $tl[$tl.Count - 1].Groups[1].Value; $st.calls += $tl.Count }
        $wt = $rxWaitTool.Match($line)
        if ($wt.Success -and ($wt.Groups[2].Value -ne 'mcp__ccd_session__start_session' -or $line.IndexOf('"initiation":"offer"', [StringComparison]::Ordinal) -ge 0)) {
          $st.waitId = $wt.Groups[1].Value; $st.waitAt = $lts
        }
        $ef = $rxEffort.Match($line); if ($ef.Success) { $st.effort = $ef.Groups[1].Value }
        $s = $rxStop.Match($line); $st.stop = if ($s.Success) { $s.Groups[1].Value } else { '' }
        if ($line.IndexOf('"usage"', [StringComparison]::Ordinal) -ge 0) {
          $u = $rxUsage.Match($line); $m = $rxId.Match($line)
          if ($u.Success -and $m.Success) {
            $v = @([long]$u.Groups[1].Value, [long]$u.Groups[2].Value, [long]$u.Groups[3].Value, [long]$u.Groups[4].Value)
            $old = $st.msgs[$m.Groups[1].Value]
            if ($old) { $st.tin -= $old[0]; $st.tcw -= $old[1]; $st.tcr -= $old[2]; $st.tout -= $old[3] }
            $st.msgs[$m.Groups[1].Value] = $v
            $st.tin += $v[0]; $st.tcw += $v[1]; $st.tcr += $v[2]; $st.tout += $v[3]
            if ($lts) { $st.lastReq = $lts }
          }
        }
        if ($line.IndexOf('"name":"TodoWrite"', [StringComparison]::Ordinal) -ge 0) {
          $o = $line | ConvertFrom-Json
          foreach ($c in $o.message.content) {
            if ($c.name -eq 'TodoWrite') {
              $st.todos = @($c.input.todos)
              foreach ($td in $st.todos) {
                $key = [string]$td.content
                if (-not $st.todoT.ContainsKey($key)) { $st.todoT[$key] = @{ c = $lts; a = $null; e = $null } }
                Mark-Step $st $st.todoT[$key] ([string]$td.status) $lts
              }
            }
          }
        }
        if ($line.IndexOf('"name":"TaskCreate"', [StringComparison]::Ordinal) -ge 0) {
          $o = $line | ConvertFrom-Json
          foreach ($c in $o.message.content) {
            if ($c.name -eq 'TaskCreate') {
              # 上一份清单已经全部做完：这是一份新清单，旧的完成项不再计入（编号照旧往下数）
              if ($st.tasks.Count -gt 0 -and -not ($st.tasks.Values | Where-Object { $_.s -ne 'completed' })) { $st.tasks.Clear() }
              $st.taskN++; $st.tasks["$($st.taskN)"] = @{ s = 'pending'; t = $c.input.subject; c = $lts; a = $null; e = $null }
            }
          }
        }
        # 桌面版的任务清单；wrap_up 收尾时把正在做的那步勾掉
        if ($line.IndexOf('"name":"mcp__ccd_turn__update_plan"', [StringComparison]::Ordinal) -ge 0 -or $line.IndexOf('"name":"mcp__ccd_turn__wrap_up"', [StringComparison]::Ordinal) -ge 0) {
          $o = $line | ConvertFrom-Json
          foreach ($c in $o.message.content) {
            if ($c.name -eq 'mcp__ccd_turn__update_plan') { Apply-Plan $st $c.input $lts }
            elseif ($c.name -eq 'mcp__ccd_turn__wrap_up') {
              foreach ($t in $st.tasks.Values) { if ($t.s -eq 'in_progress') { $t.s = 'completed'; Mark-Step $st $t 'completed' $lts } }
            }
          }
        }
        foreach ($tu in $rxTaskUpd.Matches($line)) {
          $id = $tu.Groups[1].Value
          if ($st.tasks.Contains($id)) {
            $s2 = $tu.Groups[2].Value
            if ($s2 -eq 'deleted') { $st.tasks.Remove($id) } else { $st.tasks[$id].s = $s2; Mark-Step $st $st.tasks[$id] $s2 $lts }
          }
        }
      }
      if (-not $st.cwd) { $c2 = $rxCwd.Match($line); if ($c2.Success) { $st.cwd = Unesc $c2.Groups[1].Value } }
      continue
    }
    if ($line.IndexOf('"custom-title"', [StringComparison]::Ordinal) -ge 0) { $t = $rxTitle.Match($line); if ($t.Success) { $st.title = Unesc $t.Groups[1].Value } }
    elseif ($line.IndexOf('"last-prompt"', [StringComparison]::Ordinal) -ge 0) { $p = $rxPrompt.Match($line); if ($p.Success) { $st.prompt = Unesc $p.Groups[1].Value } }
  }
}

# 桌面应用的会话元数据：cliSessionId（= transcript 文件名）→ 应用里的会话编号、标题、是否已归档
$appRoot = Join-Path $env:APPDATA 'Claude\claude-code-sessions'
$meta = @{}
$rxLocal = [regex]'"sessionId":"(local_[^"]+)"'
$rxCli = [regex]'"cliSessionId":"([^"]+)"'
$rxArch = [regex]'"isArchived":(true|false)'
$rxAppTitle = [regex]'"title":"((?:[^"\\]|\\.)*)"'
# 应用重启后同一个会话会换一个新的 transcript，旧的 id 记在 priorCliSessionIds 里
$rxPrior = [regex]'"priorCliSessionIds":\[([^\]]*)\]'
# Remote Control 的会话编号（session_…）：别的电脑点这张卡时用它打开；开关过几次会有几个，最后一个是现在的
$rxBridge = [regex]'"bridgeSessionIds":\[([^\]]*)\]'
$rxBridgeId = [regex]'"((?:cse|session)_[A-Za-z0-9_-]+)"'
$rxQuoted = [regex]'"([^"]+)"'

function Get-DesktopMap {
  $map = @{}
  $script:prior = @{}
  foreach ($f in Get-ChildItem $appRoot -Recurse -Filter 'local_*.json' -File) {
    $c = $meta[$f.FullName]
    if (-not $c -or $c.mtime -ne $f.LastWriteTimeUtc.Ticks) {
      $txt = [System.IO.File]::ReadAllText($f.FullName, $utf8)
      $l = $rxLocal.Match($txt); $k = $rxCli.Match($txt); $a = $rxArch.Match($txt); $t = $rxAppTitle.Match($txt)
      $c = @{
        mtime = $f.LastWriteTimeUtc.Ticks
        local = if ($l.Success) { $l.Groups[1].Value } else { '' }
        cli = if ($k.Success) { $k.Groups[1].Value } else { '' }
        archived = ($a.Success -and $a.Groups[1].Value -eq 'true')
        title = if ($t.Success) { Unesc $t.Groups[1].Value } else { '' }
        prior = @()
        bridge = ''
      }
      $p = $rxPrior.Match($txt)
      if ($p.Success) { $c.prior = @($rxQuoted.Matches($p.Groups[1].Value) | ForEach-Object { $_.Groups[1].Value }) }
      $br = $rxBridge.Match($txt)
      if ($br.Success) {
        $ids = @($rxBridgeId.Matches($br.Groups[1].Value) | ForEach-Object { $_.Groups[1].Value })
        if ($ids.Count -gt 0) { $c.bridge = $ids[-1] }
      }
      $meta[$f.FullName] = $c
    }
    if ($c.cli) { $map[$c.cli] = $c }
    foreach ($old in $c.prior) { if ($old -ne $c.cli) { $script:prior[$old] = $true } }
  }
  return $map
}

function Get-St($path) {
  if (-not $files.ContainsKey($path)) { $files[$path] = New-FileState }
  $st = $files[$path]; Read-New $path $st; return $st
}

do {
  # 不是主扫描：先试一次拿锁；拿不到就转发主扫描 10 秒内写的那一行（太旧或不完整就这一轮不输出）
  if (-not $Once -and -not $lockFs -and -not (Try-Lock)) {
    if ($LeadOnly) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ follow = $fwdPath } -Compress)); [Console]::Out.Flush(); exit 0 }
    try {
      $fi = [System.IO.FileInfo]::new($fwdPath)
      if ($fi.Exists -and ((Get-Date) - $fi.LastWriteTime).TotalSeconds -lt 10) {
        $text = [System.IO.File]::ReadAllText($fwdPath, $utf8).Trim()
        if ($text.StartsWith('{') -and $text.EndsWith('}')) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
      }
    } catch { }
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  $now = Get-Date
  $cut = $now.AddHours(-$Hours)
  $desk = Get-DesktopMap
  # 侧边栏里已归档的会话不显示；被同一会话的新 transcript 接替的旧 transcript 也不显示
  $main = Get-ChildItem $root -Directory | ForEach-Object { Get-ChildItem $_.FullName -Filter *.jsonl -File } |
    Where-Object { $_.LastWriteTime -gt $cut -and -not ($desk[$_.BaseName] -and $desk[$_.BaseName].archived) -and -not $prior.ContainsKey($_.BaseName) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First $Max

  $out = foreach ($f in $main) {
    $st = Get-St $f.FullName
    $id = $f.BaseName
    $mtime = $f.LastWriteTime
    # 最后一条带时间的消息（主会话和子代理里最新的）：App 往 transcript 末尾补写的后台信息没有时间，不算
    $msgT = $st.lastTs
    # 子代理 transcript：<session>\subagents\*.jsonl
    $sub = @{ tin = 0L; tcw = 0L; tcr = 0L; tout = 0L; n = 0; active = 0 }
    $subRows = @()
    $nowU = $now.ToUniversalTime()
    # 桌面应用的临时工作区目录名很长，子代理路径会超过 260 字符：加 \\?\ 前缀才能读
    $subDir = LongPath (Join-Path $f.DirectoryName "$id\subagents")
    if ([System.IO.Directory]::Exists($subDir)) {
      foreach ($sf in Get-ChildItem -LiteralPath $subDir -Filter *.jsonl -File) {
        $ss = Get-St $sf.FullName
        $sub.tin += $ss.tin; $sub.tcw += $ss.tcw; $sub.tcr += $ss.tcr; $sub.tout += $ss.tout; $sub.n++
        # 跑完的子代理最后一步是 end_turn，或交回结果的 SubagentHandback 调用
        $isActive = (($now - $sf.LastWriteTime).TotalSeconds -lt 60 -and $ss.stop -ne 'end_turn' -and $ss.tool -ne 'SubagentHandback')
        if ($isActive) { $sub.active++ }
        if ($sf.LastWriteTime -gt $mtime) { $mtime = $sf.LastWriteTime }
        if ($ss.lastTs -and (-not $msgT -or $ss.lastTs -gt $msgT)) { $msgT = $ss.lastTs }
        # 子代理明细行：正在跑的，和这一轮里跑完的（名字、类型来自旁边的 .meta.json）
        if ($isActive -or ($st.turnAt -and $ss.lastTs -and $ss.lastTs -ge $st.turnAt)) {
          # .meta.json 可能比 transcript 晚一点写出来：没读到就下一轮再读
          if (-not $ss.agentType) {
            $ss.agentType = ''; $ss.desc = ''
            $mf = LongPath ([System.IO.Path]::ChangeExtension($sf.FullName, '.meta.json'))
            if ([System.IO.File]::Exists($mf)) {
              $mj = [System.IO.File]::ReadAllText($mf, $utf8) | ConvertFrom-Json
              if ($mj) { $ss.agentType = [string]$mj.agentType; $ss.desc = [string]$mj.description }
            }
          }
          $from = $ss.firstTs; $to = if ($isActive) { $nowU } else { $ss.lastTs }
          $subRows += [ordered]@{
            name = $ss.agentType; desc = $ss.desc; model = $ss.model; tool = if ($isActive) { $ss.tool } else { '' }
            effort = $ss.effort; calls = [int]$ss.calls
            sec = if ($from -and $to) { [int]($to - $from).TotalSeconds } else { 0 }; active = $isActive
            at = if ($from) { $from.Ticks } else { 0L }
          }
        }
      }
    }
    # 正在跑的在前，各自按开始时间；最多 30 行（at 先留着，下面要用它找是哪一步派出去的）
    $subRows = @($subRows | Sort-Object @{ e = { -not $_.active } }, @{ e = { $_.at } } | Select-Object -First 30)
    $age = ($now - $mtime).TotalSeconds
    $msgAge = if ($msgT) { ($now.ToUniversalTime() - $msgT).TotalSeconds } else { $age }
    # 主会话的缓存只被主 transcript 里的请求续期（子代理用自己的缓存前缀）
    $cacheAge = if ($st.lastReq) { [int]($now.ToUniversalTime() - $st.lastReq).TotalSeconds } else { -1 }

    # 状态：根据最后一条消息和文件多久没动
    if ($sub.active -gt 0) { $status = 'running' }
    elseif ($st.kind -eq 'assistant' -and $st.stop -eq 'end_turn') { $status = 'done' }
    elseif ($age -lt 90 -and $msgAge -lt 90) { $status = 'running' }
    elseif ($st.kind -eq 'assistant' -and $st.stop -eq 'tool_use') { $status = 'waiting' }
    else { $status = 'idle' }
    # 派到后台的活还没收到完成通知：这一轮虽然结束了（end_turn），活还在跑，跑完会叫醒会话接着做
    $old = $nowU.AddHours(-$PENDING_MAX_H)
    foreach ($bk in @($st.bg.Keys)) { if ($st.bg[$bk] -lt $old) { $st.bg.Remove($bk) } }
    if (($status -eq 'done' -or $status -eq 'idle') -and $st.bg.Count -gt 0) { $status = 'running' }
    # 在等我：弹出来要我点的提问 / 计划审批 / 开新会话卡片还没答（这一轮结尾“下一步”框里的问题不算：那一轮已经做完了）
    if ($st.waitId -and $st.waitAt -and $st.waitAt -lt $old) { $st.waitId = '' }
    $asking = [bool]$st.waitId
    if ($asking) { $status = 'input' }
    # 会话自己报的“在等我决定”（授权框、提问、MCP 表单）比上面的猜测准：标记之后 transcript 没有新内容就算数
    # （答完会写工具结果，transcript 就比标记新了；会话没来得及清掉标记也不会一直挂着）
    $flag = Join-Path $inputDir $id
    if (Test-Path $flag) {
      $ms = ([System.IO.File]::ReadAllText($flag)).Trim()
      if ($ms -match '^\d+$') {
        $flagAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ms).LocalDateTime
        if ($flagAt -ge $mtime.AddSeconds(-2)) { $status = 'input' }
      }
    }

    $done = 0; $total = 0; $current = ''
    # 步骤明细：标题、状态、耗时（秒；完成 = 结束 - 开始，进行中 = 现在 - 开始，未开始 = -1）
    $steps = @(); $first = $null; $lastEnd = $null; $open = $false
    $stepOf = {
      param([string]$title, [string]$s, $t)
      $sec = -1
      if ($t -and $t.a) { $sec = if ($s -eq 'completed' -and $t.e) { [int]($t.e - $t.a).TotalSeconds } elseif ($s -eq 'in_progress') { [int]($nowU - $t.a).TotalSeconds } else { -1 } }
      [ordered]@{ t = $title; s = $s; sec = [math]::Max(-1, $sec) }
    }
    $timed = @()
    if ($st.tasks.Count -gt 0) {
      foreach ($t in $st.tasks.Values) {
        $total++; if ($t.s -eq 'completed') { $done++ } elseif ($t.s -eq 'in_progress' -and -not $current) { $current = $t.t }
        $steps += & $stepOf ([string]$t.t) $t.s $t; $timed += , @($t, $t.s)
      }
    } elseif ($st.todos) {
      foreach ($t in $st.todos) {
        $total++; if ($t.status -eq 'completed') { $done++ } elseif ($t.status -eq 'in_progress' -and -not $current) { $current = $t.activeForm }
        $tt = $st.todoT[[string]$t.content]
        $steps += & $stepOf ([string]$t.content) ([string]$t.status) $tt; $timed += , @($tt, [string]$t.status)
      }
    }
    # 总耗时：第一个步骤建立起；还有没做完的算到现在，全做完算到最后一步完成
    foreach ($p in $timed) {
      $t = $p[0]; if (-not $t) { continue }
      if ($t.c -and (-not $first -or $t.c -lt $first)) { $first = $t.c }
      if ($p[1] -ne 'completed') { $open = $true } elseif ($t.e -and (-not $lastEnd -or $t.e -gt $lastEnd)) { $lastEnd = $t.e }
    }
    # 清单全部做完、而且是在这一轮提问之前做完的：它属于上一件事，这一轮当作没有清单（不显示 100%）
    if ($total -gt 0 -and -not $open -and $lastEnd -and $st.turnAt -and $lastEnd -lt $st.turnAt) {
      $steps = @(); $done = 0; $total = 0; $current = ''; $first = $null
    }
    $planSec = -1
    if ($first) { $planSec = [int](($(if ($open -or -not $lastEnd) { $nowU } else { $lastEnd })) - $first).TotalSeconds }
    $turnSec = if ($st.turnAt) { [int]($nowU - $st.turnAt).TotalSeconds } else { -1 }
    if ($steps.Count -gt 40) { $steps = $steps[0..39] }
    # 每个子代理是哪一步派出去的：它开始时正在进行的那一步（同时有几步在进行就取最晚开始的）；
    # step = 在 steps 里的序号，-1 = 不在任何一步里（没有清单，或者在两步之间）
    foreach ($r in $subRows) {
      $best = -1; $bestA = 0L
      if ($steps.Count -gt 0 -and $r.at -gt 0) {
        for ($k = 0; $k -lt [math]::Min($timed.Count, $steps.Count); $k++) {
          $t = $timed[$k][0]
          if (-not $t -or -not $t.a) { continue }
          $a = $t.a.Ticks; $e = if ($t.e) { $t.e.Ticks } else { [long]::MaxValue }
          if ($a -le $r.at -and $r.at -le $e -and $a -ge $bestA) { $best = $k; $bestA = $a }
        }
      }
      $r.step = $best
      $r.Remove('at')
    }

    $d = $desk[$id]
    $title = if ($d -and $d.title) { $d.title } elseif ($st.title) { $st.title } elseif ($st.prompt) { $st.prompt } else { $id.Substring(0, 8) }
    $link = if ($d -and $d.local) { "claude://claude.ai/epitaxy/$($d.local)" } else { '' }
    $bridge = if ($d -and $d.bridge) { $d.bridge } else { '' }
    [ordered]@{
      id = $id; title = $title; link = $link; bridge = $bridge; project = (Split-Path $st.cwd -Leaf); status = $status
      ageSec = [int]$age; msgAgeSec = [int]$msgAge; cacheAgeSec = $cacheAge; done = $done; total = $total; current = $current
      input = $st.tin + $sub.tin; cacheWrite = $st.tcw + $sub.tcw; cacheRead = $st.tcr + $sub.tcr; output = $st.tout + $sub.tout
      subagents = $sub.n; subActive = $sub.active
      model = $st.model; effort = $st.effort
      steps = @($steps); planSec = $planSec; turnSec = $turnSec; subs = @($subRows)
    }
  }
  $nextSteps = $true
  $hidden = @{}
  $liveActivity = $true
  if (Test-Path $prefsPath) {
    $p = [System.IO.File]::ReadAllText($prefsPath, $utf8) | ConvertFrom-Json
    if ($p -and $p.nextSteps -eq $false) { $nextSteps = $false }
    # 本机的 iPhone Live 开关：关了推送器就不往手机推（手机上自己的开关也要开着才推）
    if ($p -and $p.liveActivity -eq $false) { $liveActivity = $false }
    # 任务板上手动隐藏的已完成会话：会话 id -> 隐藏时它最后一次请求的时间（毫秒）
    if ($p -and $p.hidden) { foreach ($h in $p.hidden.PSObject.Properties) { $hidden[$h.Name] = [int64]$h.Value } }
  }
  $usageText = ''
  if (Test-Path $usagePath) { try { $usageText = [System.IO.File]::ReadAllText($usagePath, $utf8) } catch { } }
  $nowMs = [int64](($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds)
  $snapLine = @{
    at = $nowMs; device = $Device; os = $os; sessions = @($out)
    prefs = @{ nextSteps = $nextSteps; hidden = $hidden; liveActivity = $liveActivity }; prefsPath = $prefsPath
    usagePath = $usagePath; usageText = $usageText; inputDir = $inputDir
  }
  # 本机装了 iPhone Live 推送器（有它的配置文件），任务板上才画「iPhone Live」开关
  if (Test-Path -LiteralPath $livePath) { $snapLine.livePusher = $true }
  $json = ConvertTo-Json -InputObject $snapLine -Compress -Depth 6
  # Windows PowerShell 的标准输出走系统代码页，中文会乱码：非 ASCII 一律转成 \uXXXX
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  # 先写临时文件再整个换上，读的一方不会读到半个文件（几个会话同时写，谁后换上算谁的）
  $swap = {
    param([string]$text, [string]$dest)
    $tmp = "$dest.$PID.tmp"
    try {
      [System.IO.File]::WriteAllText($tmp, $text, $utf8)
      # 第三个参数（备份路径）要用 [NullString]::Value：PowerShell 把 $null 传成空字符串，Replace 会报“路径格式不对”，快照就一直不更新
      if ([System.IO.File]::Exists($dest)) { [System.IO.File]::Replace($tmp, $dest, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $dest) }
    } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
  $writeSnap = ($now - $lastSnap).TotalSeconds -ge 10
  # 跨设备共享：本机快照（不含 remote，不然两边会互相套进去越滚越大）写到共享目录；再读其他电脑的快照
  if ($Shared) {
    # 同步盘里不用“临时文件 + 换上”：iCloud 会抢先上传 .tmp、把每次换文件当成冲突（Win 2.json、Win 3.json…），
    # 还会锁住 .tmp 让之后每一轮都写不进去。直接原地覆盖写，写不进去（文件正被同步）就跳过这一轮；读的一方读到半个文件会当坏文件跳过
    if ($writeSnap) { try { [System.IO.File]::WriteAllText((Join-Path $Shared "$Device.json"), $json, $utf8) } catch { } }
    $remote = @()
    foreach ($rf in Get-ChildItem -LiteralPath $Shared -File) {
      # 同步盘给本机文件生成的冲突副本（Win 2.json、Win(1).json）和残留的临时文件：是本机自己的东西，删掉。
      # 但 iCloud for Windows 常把刚原地写好的 Win.json 直接改名成 “Win 11.json”：那份就是最新的快照，马上删的话
      # 共享目录里大部分时间没有本机快照，别的电脑上这台的会话时有时无。所以只删 30 秒没更新的；读的一方按 device 留最新的
      if ($rf.Name -match ('^' + [regex]::Escape($Device) + '( \d+|\(\d+\))\.json$') -or $rf.Name -like "$Device.json.*.tmp") {
        if (($now.ToUniversalTime() - $rf.LastWriteTimeUtc).TotalSeconds -ge 30) { Remove-Item -LiteralPath $rf.FullName -Force -ErrorAction SilentlyContinue }
        continue
      }
      if ($rf.Extension -ne '.json' -or $rf.Name -eq "$Device.json") { continue }
      try {
        $text = [System.IO.File]::ReadAllText($rf.FullName, $utf8).Trim()
        $head = $text | ConvertFrom-Json
        # 要有本机名和时间；本机名和自己一样的（同步盘的冲突副本）不要；太久没更新的 = 离线，跳过
        if (-not $head -or -not ($head.device -is [string]) -or -not $head.device -or $head.device -eq $Device) { continue }
        $at = $head.at -as [int64]
        if (-not $at -or ($nowMs - $at) -gt $SHARED_MAX_MS) { continue }
        if (-not $text.StartsWith('{') -or -not $text.EndsWith('}')) { continue }
        # 原样附上（不重新序列化，深度和中文转义都保持原样）；共享目录里的快照本来就不含 remote
        $remote += $text
      } catch { }
    }
    if ($remote.Count -gt 0) {
      $json = $json.Substring(0, $json.Length - 1) + ',"remote":[' + ($remote -join ',') + ']}'
      # 别的电脑的快照本该是纯 ASCII 的；不是的话（别的工具写的）这里再转一次，不然标准输出会变问号
      $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    }
  }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  # 主扫描：同一行写给跟随的扫描进程转发（本机文件，换名写没问题）
  if ($lockFs) { & $swap $json $fwdPath }
  # 本机的共用快照最多 10 秒写一次（带 remote：新会话一启动就能看到别的电脑）
  if ($writeSnap) {
    $lastSnap = $now
    & $swap $json $snapPath
  }
  if (-not $Once) { Start-Sleep -Milliseconds $IntervalMs }
} while (-not $Once)
