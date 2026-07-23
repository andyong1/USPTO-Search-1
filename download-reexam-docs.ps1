# Download every reexamination DETERMINATION and OFFICE ACTION PDF listed on the
# site into .\downloads\ (determinations\ and office-actions\ subfolders).
#
# No install needed — works in the Windows PowerShell that ships with Windows 11.
# Run it from this folder:
#     powershell -ExecutionPolicy Bypass -File .\download-reexam-docs.ps1
#
# Options (set before running, e.g.  $env:OUT_DIR = "D:\reexam"):
#     SITE_BASE   site origin (default https://andy-ong.com)
#     OUT_DIR     output folder (default .\downloads)
# Safe to re-run: files already downloaded are skipped, so you can stop/resume,
# and re-run later to grab newly-added documents.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Base = if ($env:SITE_BASE) { $env:SITE_BASE.TrimEnd('/') } else { 'https://andy-ong.com' }
$Out  = if ($env:OUT_DIR)  { $env:OUT_DIR } else { '.\downloads' }

function San([string]$s) { return ($s -replace '[^0-9A-Za-z._-]', '_') }
function Ymd([string]$s) { if ($s -match '(\d{4})-?(\d{2})-?(\d{2})') { "$($matches[1])-$($matches[2])-$($matches[3])" } else { 'nodate' } }

Write-Host "Fetching document lists from $Base ..."
$dets = (Invoke-RestMethod -Uri "$Base/api/reexam").determinations
$acts = (Invoke-RestMethod -Uri "$Base/api/reexam?actions=1").actions

$jobs = New-Object System.Collections.ArrayList
foreach ($d in $dets) {
  if ($d.document_identifier) {
    [void]$jobs.Add([pscustomobject]@{ App = $d.application_number; Doc = $d.document_identifier; Dir = 'determinations';
      Name = "$(San $d.application_number)_$(San $d.determination_type)_$(Ymd $d.official_date)_$(San $d.document_identifier)" })
  }
}
foreach ($a in $acts) {
  if ($a.nonf_doc_id) { [void]$jobs.Add([pscustomobject]@{ App = $a.application_number; Doc = $a.nonf_doc_id; Dir = 'office-actions';
    Name = "$(San $a.application_number)_nonfinal_$(Ymd $a.nonf_date)_$(San $a.nonf_doc_id)" }) }
  if ($a.finl_doc_id) { [void]$jobs.Add([pscustomobject]@{ App = $a.application_number; Doc = $a.finl_doc_id; Dir = 'office-actions';
    Name = "$(San $a.application_number)_final_$(Ymd $a.finl_date)_$(San $a.finl_doc_id)" }) }
}

Write-Host "$($dets.Count) determinations, $($acts.Count) office-action rows -> $($jobs.Count) PDFs into $Out"
Write-Host ""

$ok = 0; $skip = 0; $fail = 0; $errs = @(); $i = 0
foreach ($j in $jobs) {
  $i++
  $dirPath = Join-Path $Out $j.Dir
  if (-not (Test-Path $dirPath)) { New-Item -ItemType Directory -Path $dirPath -Force | Out-Null }
  $file = Join-Path $dirPath ($j.Name + '.pdf')
  if (Test-Path $file) { $skip++ ; continue }

  $url = "$Base/api/document?appNum=$([uri]::EscapeDataString([string]$j.App))&documentId=$([uri]::EscapeDataString([string]$j.Doc))&format=PDF&disposition=attachment"
  try {
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing -TimeoutSec 90
    # sanity-check the file really is a PDF (not an error page)
    $fs = [System.IO.File]::OpenRead($file); $hdr = New-Object byte[] 5; [void]$fs.Read($hdr, 0, 5); $fs.Close()
    if ([System.Text.Encoding]::ASCII.GetString($hdr) -ne '%PDF-') { Remove-Item $file -Force; throw 'not a PDF' }
    $ok++
  } catch {
    $fail++; $errs += "$($j.App)/$($j.Doc): $($_.Exception.Message)"
    if (Test-Path $file) { Remove-Item $file -Force -ErrorAction SilentlyContinue }
  }
  Write-Progress -Activity "Downloading reexam PDFs" -Status "$i of $($jobs.Count)  (downloaded=$ok skipped=$skip failed=$fail)" -PercentComplete ([int](($i / [math]::Max($jobs.Count,1)) * 100))
}
Write-Progress -Activity "Downloading reexam PDFs" -Completed

Write-Host ""
Write-Host "Done. $ok downloaded, $skip already present, $fail failed."
if ($fail -gt 0) {
  Write-Host "Failures (first 25):"
  $errs | Select-Object -First 25 | ForEach-Object { Write-Host "  $_" }
  Write-Host "Re-run the script to retry failures (already-downloaded files are skipped)."
}
