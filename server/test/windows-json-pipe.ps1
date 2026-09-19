param([string]$NodePath, [string]$CliPath, [string]$LogPath, [switch]$ErrorCase)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936)
if ($ErrorCase) {
    & $NodePath $CliPath tools describe 'missing-中文-🧩' | Tee-Object -FilePath $LogPath | Out-Null
} else {
    & $NodePath $CliPath skills show | Tee-Object -FilePath $LogPath | Out-Null
}
$nativeExitCode = $LASTEXITCODE
Get-Content -LiteralPath $LogPath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop | Out-Null
[Console]::Out.WriteLine($nativeExitCode)
