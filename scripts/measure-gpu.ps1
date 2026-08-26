# 量 deskmind 整个进程树的 GPU 占用。ADR 0016 的功耗硬线就是拿它来对的。
#
# 在仓库根目录运行：powershell -ExecutionPolicy Bypass -File scripts\measure-gpu.ps1 -Seconds 20 -Label 空闲可见
#
# GPU 活干在 WebView2 的 GPU 子进程里，不在 deskmind.exe 自身，所以要把整棵树的 pid
# 都收进来再求和。计数器实例名形如 pid_1234_..._engtype_3d，各引擎分开计，求和后超
# 100 也正常。
#
# 前提：上下文必须是硬件加速的。桌面层窗口的 devtools 里读 window.__dmRenderer 确认不是
# SwiftShader——不过 3D 引擎上量到非零占用本身就说明活干在 GPU 上，软件渲染只会烧 CPU。

param(
  [int]$Seconds = 20,
  [string]$Label = ''
)

$ErrorActionPreference = 'Stop'

$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$roots = @($all | Where-Object { $_.Name -eq 'deskmind.exe' })
if ($roots.Count -eq 0) { throw 'deskmind 没在跑。先启动它再量。' }

# 广度优先抓整棵树：WebView2 的渲染、GPU、工具进程都是 deskmind.exe 的后代。
$pids = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Queue]::new()
foreach ($r in $roots) { [void]$pids.Add([int]$r.ProcessId); $queue.Enqueue([int]$r.ProcessId) }
while ($queue.Count -gt 0) {
  $parent = $queue.Dequeue()
  foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
    if ($pids.Add([int]$c.ProcessId)) { $queue.Enqueue([int]$c.ProcessId) }
  }
}

$pattern = '^pid_(' + (($pids | Sort-Object) -join '|') + ')_'
Write-Host "进程树：$($pids.Count) 个 pid（$(($pids | Sort-Object) -join ', ')）"
if ($Label) { Write-Host "场景：$Label" }
Write-Host "量 $Seconds 秒，每秒一个样本……"

$series = @()
foreach ($sample in Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples $Seconds) {
  $mine = $sample.CounterSamples | Where-Object { $_.InstanceName -match $pattern }
  $total = [math]::Round((($mine | Measure-Object CookedValue -Sum).Sum), 2)
  $series += $total
  Write-Host ("  {0,6:N2}%" -f $total)
}

$sorted = $series | Sort-Object
$median = $sorted[[int]($sorted.Count / 2)]
$max = ($series | Measure-Object -Maximum).Maximum
$mean = [math]::Round((($series | Measure-Object -Average).Average), 2)

Write-Host ''
Write-Host ("中位数 {0:N2}%  平均 {1:N2}%  峰值 {2:N2}%" -f $median, $mean, $max)

# ADR 0016 的线是空闲可见不超过 1-2%。被遮挡那条要求「一帧不画」，只有峰值能戳破。
# 计数器本身有量化噪声，0.05% 以下读作「没画」。
if ($max -le 0.05) { Write-Host '结论：量不到，按一帧都没画算。' }
elseif ($median -le 2) { Write-Host '结论：中位数在线内，看峰值是否只是偶发。' }
else { Write-Host '结论：超线。' }
