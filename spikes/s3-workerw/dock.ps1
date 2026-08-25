<#
S3 spike — can a normal window live at desktop level, and still take input?

Docks a target window into the layer between the wallpaper and the desktop icons,
the technique Wallpaper Engine and Lively use. The question worth answering is not
whether docking works — it does — but whether a docked window still receives mouse
clicks and keystrokes. That decides whether deskmind can live on the desktop
instead of being summoned by a hotkey.

There are two shell layouts in the wild and they need different targets:
  A) Progman > SHELLDLL_DefView   — icons live in Progman, WorkerW is a sibling
  B) WorkerW > SHELLDLL_DefView   — icons were migrated into a WorkerW
`-Dump` shows which one this machine has, plus every candidate, so the choice is
made from evidence rather than from an algorithm that assumed one layout.

Usage:
  powershell -ExecutionPolicy Bypass -File .\dock.ps1 -Dump
  powershell -ExecutionPolicy Bypass -File .\dock.ps1 -Process notepad -FullScreen
  powershell -ExecutionPolicy Bypass -File .\dock.ps1 -Process notepad -Restore
  powershell -ExecutionPolicy Bypass -File .\dock.ps1 -Process notepad -Hwnd 70066
#>

[CmdletBinding()]
param(
  [string]$Process,
  [switch]$Restore,
  [switch]$Dump,
  [switch]$FullScreen,
  # Try to hand keyboard focus to an already-docked window.
  [switch]$Focus,
  # Force a specific parent, for trying candidates by hand.
  [long]$Hwnd = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

public class Win {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string lpClassName, string lpWindowName);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetFocus(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetFocus();

  [DllImport("user32.dll")]
  public static extern IntPtr GetParent(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  public static string ClassOf(IntPtr hWnd) {
    StringBuilder sb = new StringBuilder(256);
    GetClassName(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  // Forcing focus onto a window that is not part of the active top-level window
  // needs the input queues joined first: SetFocus only reaches windows in the
  // calling thread's queue. This is the same manoeuvre Lively's input forwarding
  // rests on, and it is fragile by nature — Windows deliberately makes stealing
  // focus hard.
  public static string ForceFocus(IntPtr child) {
    IntPtr top = child;
    IntPtr p;
    while ((p = GetParent(top)) != IntPtr.Zero) { top = p; }

    uint dummy;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint mine = GetCurrentThreadId();

    bool attached = AttachThreadInput(mine, fgThread, true);
    bool fg = SetForegroundWindow(top);
    IntPtr had = SetFocus(child);
    IntPtr now = GetFocus();
    if (attached) { AttachThreadInput(mine, fgThread, false); }

    return "顶层父窗口=" + top + " 队列已连接=" + attached
         + " SetForegroundWindow=" + fg + " 之前的焦点=" + had + " 现在的焦点=" + now;
  }
}

"@

# Undocumented. Sending it to Progman makes the shell create the WorkerW that
# sits behind the desktop icons; without it there may be nothing to parent into.
$SPAWN_WORKERW = 0x052C
$SMTO_NORMAL = 0x0000
$NUL = [NullString]::Value

$screenW = [Win]::GetSystemMetrics(0)
$screenH = [Win]::GetSystemMetrics(1)

function Spawn-WorkerW {
  $progman = [Win]::FindWindow("Progman", $NUL)
  if ($progman -eq [IntPtr]::Zero) { throw "找不到 Progman 窗口" }
  $unused = [IntPtr]::Zero
  [void][Win]::SendMessageTimeout($progman, $SPAWN_WORKERW, [IntPtr]::Zero, [IntPtr]::Zero, $SMTO_NORMAL, 1000, [ref]$unused)
  Start-Sleep -Milliseconds 120
  $progman
}

# Enumerates top-level windows in z-order and annotates the ones that could serve
# as a desktop-level parent.
function Get-Candidates {
  $script:rows = New-Object System.Collections.ArrayList
  $i = 0
  $cb = [Win+EnumProc] {
    param($hwnd, $lparam)
    $cls = [Win]::ClassOf($hwnd)
    if ($cls -eq "WorkerW" -or $cls -eq "Progman") {
      $r = New-Object RECT
      [void][Win]::GetWindowRect($hwnd, [ref]$r)
      $dv = [Win]::FindWindowEx($hwnd, [IntPtr]::Zero, "SHELLDLL_DefView", $NUL)
      [void]$script:rows.Add([pscustomobject]@{
        Z        = $script:i
        Hwnd     = [long]$hwnd
        Class    = $cls
        Visible  = [Win]::IsWindowVisible($hwnd)
        Width    = $r.Right - $r.Left
        Height   = $r.Bottom - $r.Top
        HasIcons = ($dv -ne [IntPtr]::Zero)
      })
    }
    $script:i++
    return $true
  }
  $script:i = 0
  [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
  $script:rows
}

# Prefers a full-screen, visible WorkerW with no icon layer of its own — that is
# the one 0x052C creates behind the icons. Falls back to Progman, which puts us at
# desktop level too, just above the icons instead of below them.
function Pick-Parent($rows, $progman) {
  $best = $rows |
    Where-Object { $_.Class -eq "WorkerW" -and -not $_.HasIcons -and $_.Visible -and $_.Width -ge $screenW } |
    Select-Object -First 1
  if ($best) { return @([IntPtr]$best.Hwnd, "全屏可见且无图标层的 WorkerW") }

  $any = $rows |
    Where-Object { $_.Class -eq "WorkerW" -and -not $_.HasIcons -and $_.Width -ge $screenW } |
    Select-Object -First 1
  if ($any) { return @([IntPtr]$any.Hwnd, "全屏但当前不可见的 WorkerW") }

  return @($progman, "退回 Progman（会在图标之上）")
}

function Get-TargetWindow([string]$name) {
  $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowHandle -ne 0 } |
          Select-Object -First 1
  if (-not $proc) { throw "没有找到进程 $name 的可见窗口。先把它打开。" }
  Write-Host "目标：$($proc.ProcessName) (PID $($proc.Id)) hwnd=$($proc.MainWindowHandle)"
  $proc.MainWindowHandle
}

# ---------- dump ----------

if ($Dump) {
  $progman = Spawn-WorkerW
  Write-Host "屏幕 ${screenW}x${screenH} · Progman=$progman"
  $rows = Get-Candidates
  $rows | Format-Table -AutoSize
  $pick = Pick-Parent $rows $progman
  Write-Host "会选：$($pick[0])  理由：$($pick[1])"
  Write-Host ""
  Write-Host "布局判断："
  $iconHost = $rows | Where-Object { $_.HasIcons } | Select-Object -First 1
  if ($iconHost) {
    Write-Host "  图标层挂在 $($iconHost.Class) ($($iconHost.Hwnd)) 下"
  } else {
    Write-Host "  没找到图标层，桌面图标可能被隐藏了"
  }
  return
}

if (-not $Process) { throw "要么给 -Process，要么给 -Dump。" }
$target = Get-TargetWindow $Process

# ---------- focus experiment ----------

if ($Focus) {
  Write-Host ([Win]::ForceFocus($target))
  Write-Host ""
  Write-Host "现在直接打字（别点任何东西）。打进去了说明键盘可以争取到，"
  Write-Host "桌面层能做成完整可交互；打不进去说明这条路封死。"
  return
}

# ---------- restore ----------

if ($Restore) {
  [void][Win]::SetParent($target, [IntPtr]::Zero)
  Write-Host "已脱离桌面层，恢复为普通窗口。"
  return
}

# ---------- dock ----------

$progman = Spawn-WorkerW

if ($Hwnd -ne 0) {
  $parent = [IntPtr]$Hwnd
  $why = "命令行指定"
} else {
  $rows = Get-Candidates
  $picked = Pick-Parent $rows $progman
  $parent = $picked[0]
  $why = $picked[1]
}
Write-Host "父窗口：$parent  ($why)"

[void][Runtime.InteropServices.Marshal]::GetLastWin32Error()
$previous = [Win]::SetParent($target, $parent)
if ($previous -eq [IntPtr]::Zero) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -ne 0) { throw "SetParent 失败，错误码 $code" }
}

if ($FullScreen) {
  # SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW
  [void][Win]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, $screenW, $screenH, (0x0004 -bor 0x0010 -bor 0x0040))
  Write-Host "已铺满 ${screenW}x${screenH}"
}

Write-Host ""
Write-Host "已挂到桌面层。逐条检查，这几条决定 deskmind 能不能常驻桌面："
Write-Host ""
Write-Host "  1. 它在壁纸之上吗？在桌面图标之下还是之上？"
Write-Host "  2. 打开其他应用，它是否正常被盖住，而不是浮到最前？"
Write-Host "  3. 鼠标点它有反应吗？          ← 最关键"
Write-Host "  4. 点完能打字吗？键盘焦点进得去吗？ ← 最关键"
Write-Host "  5. 按 Win+D 显示桌面，它还在吗？"
Write-Host "  6. 最小化所有窗口后它可见吗？"
Write-Host ""
Write-Host "换个父窗口试：.\dock.ps1 -Process $Process -FullScreen -Hwnd <上面表里的某个>"
Write-Host "恢复：        .\dock.ps1 -Process $Process -Restore"
