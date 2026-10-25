# Compile and initialize the exact bundled helper without injecting any input.
$ErrorActionPreference = 'Stop'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$helper = Join-Path $PSScriptRoot 'native\input.ps1'
$output = '{"kind":"quit"}' | & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $helper
if ($LASTEXITCODE -ne 0) {
    throw "The Windows input helper exited with code $LASTEXITCODE."
}
if (@($output | Where-Object { $_.ToString().Trim() -eq 'INHOUSE_INPUT_READY' }).Count -ne 1) {
    throw 'The Windows input helper did not confirm successful compilation and initialization.'
}
Write-Output 'Windows native helper compiled and exited cleanly; no input events were injected.'
