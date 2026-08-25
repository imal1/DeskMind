<#
S1 spike — verify AI grouping quality before building anything.

Scans the user's real Start Menu shortcuts and Desktop, asks a model to group
them into zones, and writes a checklist. The user marks every item they would
have put somewhere else; -Score then reports the manual-adjustment rate.

Acceptance threshold: <= 20% (ADR 0013). Above that, the core product
hypothesis is not supported and building should stop.

Usage:
  # Anthropic
  .\s1-grouping.ps1 -ApiKey sk-ant-...

  # DeepSeek (or any OpenAI-compatible endpoint)
  .\s1-grouping.ps1 -ApiKey sk-... -BaseUrl https://api.deepseek.com/chat/completions -Model deepseek-chat

  # score after marking the checklist
  .\s1-grouping.ps1 -Score

The request shape is inferred from -BaseUrl: anthropic.com uses the Messages
API, anything else is treated as OpenAI-compatible.
#>

[CmdletBinding()]
param(
  [string]$ApiKey  = $(if ($env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY } else { $env:DEEPSEEK_API_KEY }),
  [string]$Model   = 'claude-sonnet-4-5',
  [string]$BaseUrl = 'https://api.anthropic.com/v1/messages',
  [int]$ZoneCount  = 7,
  [switch]$Score
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$ResultFile = Join-Path $PSScriptRoot 's1-result.md'
$RawFile    = Join-Path $PSScriptRoot 's1-raw.json'
$Threshold  = 20

# ---------- scoring mode ----------

if ($Score) {
  if (-not (Test-Path $ResultFile)) { throw "找不到 $ResultFile，先不带 -Score 跑一次。" }
  $lines = Get-Content $ResultFile -Encoding UTF8
  $total  = ($lines | Where-Object { $_ -match '^\s*-\s\[[ xX]\]' }).Count
  $moved  = ($lines | Where-Object { $_ -match '^\s*-\s\[[xX]\]' }).Count
  if ($total -eq 0) { throw "$ResultFile 里没有条目。" }

  $mech = $lines | Where-Object { $_ -match '^<!-- mechanical' } | Select-Object -First 1
  $miss = 0; $fab = 0; $dup = 0; $input = 0
  if ($mech -match 'missing=(\d+) fabricated=(\d+) dupes=(\d+) input=(\d+)') {
    $miss = [int]$Matches[1]; $fab = [int]$Matches[2]
    $dup  = [int]$Matches[3]; $input = [int]$Matches[4]
  }

  $rate = [math]::Round(100 * $moved / $total, 1)
  Write-Host ""
  Write-Host "清单条目      $total" -NoNewline
  if ($input) { Write-Host "   (输入 $input 项)" } else { Write-Host "" }
  Write-Host "你标记挪走    $moved"
  Write-Host "手动调整率    $rate%   (验收线 $Threshold%)"
  if ($miss -or $fab -or $dup) {
    Write-Host "机械错误      漏 $miss · 编造 $fab · 重复 $dup" -ForegroundColor Yellow
  }
  Write-Host ""

  # Guard rails: a number produced from a broken run is worse than no number.
  if ($fab -gt 0) {
    Write-Host "结果不可信：模型返回了 $fab 个输入里没有的条目，通常是响应编码坏了。" -ForegroundColor Red
    Write-Host "修掉再重跑，别用这轮的数字下结论。" -ForegroundColor Red
    return
  }
  if ($moved -eq 0) {
    Write-Host "你还没有标记任何一项。这个 0% 没有意义——先逐条审一遍清单。" -ForegroundColor Red
    return
  }

  if ($rate -le $Threshold) {
    Write-Host "达标。核心假设成立，可以往下做。" -ForegroundColor Green
    if ($miss) { Write-Host "但有 $miss 项没被分类，提示词还能再紧一紧。" -ForegroundColor Yellow }
  } else {
    Write-Host "未达标。先改提示词或分区粒度再测一轮；连续几轮都过不了，说明方向要重想。" -ForegroundColor Yellow
  }
  return
}

# ---------- collect launch targets ----------

$ApiKey = "$ApiKey".Trim().Trim('"').Trim("'")
if (-not $ApiKey) { throw "需要 API key：用 -ApiKey 传入，或设置环境变量 ANTHROPIC_API_KEY / DEEPSEEK_API_KEY" }

$startMenus = @(
  Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
  Join-Path $env:APPDATA     'Microsoft\Windows\Start Menu\Programs'
)
$desktops = @(
  [Environment]::GetFolderPath('Desktop')
  Join-Path $env:PUBLIC 'Desktop'
)

# Junk that pollutes every Start Menu and would distort the measurement.
$junk = '卸载|uninstall|帮助|help$|readme|说明|官网|website|документ|documentation|修复|repair|change log|changelog|license|反馈|feedback'

$items = New-Object System.Collections.Generic.List[object]

foreach ($dir in $startMenus) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |
    ForEach-Object { $items.Add([pscustomobject]@{ Name = $_.BaseName; Source = 'startmenu' }) }
}

foreach ($dir in $desktops) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^desktop\.ini$' } |
    ForEach-Object {
      $n = if ($_.Extension -eq '.lnk') { $_.BaseName } else { $_.Name }
      $items.Add([pscustomobject]@{ Name = $n; Source = 'desktop' })
    }
}

$names = $items.Name |
  Where-Object { $_ -and $_.Trim() -and $_ -notmatch $junk } |
  Sort-Object -Unique

if ($names.Count -lt 5) { throw "只找到 $($names.Count) 个启动项，样本太小，测不出东西。" }

Write-Host "找到 $($names.Count) 个启动项，正在请模型分组…"

# ---------- ask the model ----------

$list = ($names | ForEach-Object { "- $_" }) -join "`n"

$prompt = @"
下面是一台 Windows 电脑上的启动项列表（已安装程序、桌面文件与文件夹）。

请把它们分成 $ZoneCount 个左右的分区。要求：

1. 分区名用中文，2-4 个字，是用户会自己起的那种名字（例如「工作」「设计」「游戏」「工具」），不要用「其他类别A」这种
2. 每一个启动项必须且只能出现在一个分区里，不能遗漏、不能重复
3. 分区粒度要均匀，避免一个分区装了一大半
4. 按用途分，不要按文件类型或首字母分

只输出 JSON，不要任何解释文字，格式：
{"zones":[{"name":"工作","items":["项目名","另一个"]}]}

启动项列表：
$list
"@

$isAnthropic = $BaseUrl -match 'anthropic\.com'

if ($isAnthropic) {
  $headers = @{
    'x-api-key'         = $ApiKey
    'anthropic-version' = '2023-06-01'
    'content-type'      = 'application/json'
  }
} else {
  $headers = @{
    'Authorization' = "Bearer $ApiKey"
    'content-type'  = 'application/json'
  }
}

$body = @{
  model      = $Model
  max_tokens = 8000
  messages   = @(@{ role = 'user'; content = $prompt })
} | ConvertTo-Json -Depth 6 -Compress

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Invoke-RestMethod decodes the response with ISO-8859-1 when the server sends
# no charset, which mangles every non-ASCII name. Read raw bytes and decode UTF-8.
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $wr = Invoke-WebRequest -Uri $BaseUrl -Method Post -Headers $headers -UseBasicParsing `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
  $resp = [Text.Encoding]::UTF8.GetString($wr.RawContentStream.ToArray()) | ConvertFrom-Json
} catch {
  $detail = $_.ErrorDetails.Message
  if (-not $detail -and $_.Exception.Response) {
    $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
    $detail = $reader.ReadToEnd()
  }
  Write-Host ""
  Write-Host "请求失败。endpoint: $BaseUrl" -ForegroundColor Red
  Write-Host "key 前缀: $($ApiKey.Substring(0,[Math]::Min(8,$ApiKey.Length)))… 长度 $($ApiKey.Length)"
  Write-Host "服务端返回: $detail"
  Write-Host ""
  Write-Host "常见原因：key 和 endpoint 不匹配（DeepSeek 的 key 打到了 Anthropic），或 key 已失效。"
  throw
}
$sw.Stop()

$text = if ($isAnthropic) { $resp.content[0].text } else { $resp.choices[0].message.content }
$text = $text -replace '(?s)^\s*```(?:json)?\s*', '' -replace '(?s)\s*```\s*$', ''
$text | Set-Content $RawFile -Encoding UTF8

try   { $parsed = $text | ConvertFrom-Json }
catch { throw "模型没有返回合法 JSON，原始输出已存到 $RawFile" }

# ---------- sanity-check the model's output ----------

$assigned = @($parsed.zones | ForEach-Object { $_.items })
$missing  = @($names | Where-Object { $_ -notin $assigned })
$extra    = @($assigned | Where-Object { $_ -notin $names })
$dupes    = @($assigned | Group-Object | Where-Object Count -gt 1 | ForEach-Object Name)

# ---------- write the checklist ----------

$out = New-Object System.Collections.Generic.List[string]
$out.Add("# S1 结果：AI 分组质量")
$out.Add("")
$out.Add("<!-- mechanical missing=$($missing.Count) fabricated=$($extra.Count) dupes=$($dupes.Count) input=$($names.Count) -->")
$out.Add("")
$out.Add("模型 ``$Model`` · 启动项 $($names.Count) 个 · 分区 $($parsed.zones.Count) 个 · 耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s")
$out.Add("")
$out.Add("**怎么用**：从头看一遍，凡是你会放到别的分区去的，把 ``[ ]`` 改成 ``[x]``。分区名起得不好但东西放对了，不算。改完存盘，然后跑：")
$out.Add("")
$out.Add('```')
$out.Add('powershell -ExecutionPolicy Bypass -File .\s1-grouping.ps1 -Score')
$out.Add('```')
$out.Add("")

if ($missing.Count -or $extra.Count -or $dupes.Count) {
  $out.Add("> **模型输出有问题**（这本身就是个信号，说明提示词还要改）：")
  if ($missing.Count) { $out.Add("> 漏掉 $($missing.Count) 项：$($missing -join '、')") }
  if ($extra.Count)   { $out.Add("> 编造 $($extra.Count) 项：$($extra -join '、')") }
  if ($dupes.Count)   { $out.Add("> 重复 $($dupes.Count) 项：$($dupes -join '、')") }
  $out.Add("")
}

foreach ($z in $parsed.zones) {
  $out.Add("## $($z.name)  ($(@($z.items).Count))")
  $out.Add("")
  foreach ($i in $z.items) { $out.Add("- [ ] $i") }
  $out.Add("")
}

if ($missing.Count) {
  $out.Add("## 未分类（模型没放进任何分区）")
  $out.Add("")
  $out.Add("这些算模型的机械错误，单独统计，**不要**在这里打勾。")
  $out.Add("")
  foreach ($i in $missing) { $out.Add("- [ ] $i") }
  $out.Add("")
}

$out | Set-Content $ResultFile -Encoding UTF8

Write-Host ""
Write-Host "分区：" -NoNewline
Write-Host (($parsed.zones | ForEach-Object { "$($_.name)($(@($_.items).Count))" }) -join '  ')
Write-Host ""
Write-Host "结果写到 $ResultFile"
Write-Host "标完想挪的项，再跑 -Score。"
