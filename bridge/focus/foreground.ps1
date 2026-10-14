# Reports the foreground window once a second as one JSON line:
#   {"app":"chrome","title":"...","host":"example.com","ok":true}
# A fresh query every tick. Nothing is cached between ticks, because a reader
# that remembers is a reader that reports the first app it saw for ever.
# For Chrome-family windows the site is read from the address bar through UI
# Automation; the path is dropped here and never leaves this process.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
'@

$browsers = @('chrome', 'msedge', 'brave', 'vivaldi', 'opera')
$editType = [System.Windows.Automation.ControlType]::Edit
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $editType)

function Get-Host([string]$raw) {
  if (-not $raw) { return '' }
  $s = $raw.Trim()
  if ($s -notmatch '^[a-z][a-z0-9+.-]*://') { $s = 'https://' + $s }
  try { return ([System.Uri]$s).Host.ToLowerInvariant() } catch { return '' }
}

while ($true) {
  $out = @{ ok = $true; app = ''; title = ''; host = '' }
  try {
    $h = [Fg]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $procId = 0
      [void][Fg]::GetWindowThreadProcessId($h, [ref]$procId)
      $sb = New-Object System.Text.StringBuilder 512
      [void][Fg]::GetWindowText($h, $sb, 512)
      $out.title = $sb.ToString()
      try { $out.app = (Get-Process -Id $procId).ProcessName.ToLowerInvariant() } catch {}
      if ($browsers -contains $out.app) {
        try {
          $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
          $bar = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)
          if ($bar) {
            $vp = $bar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $out.host = Get-Host $vp.Current.Value
          }
        } catch { $out.host = '' }
      }
    }
  } catch { $out.ok = $false }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
