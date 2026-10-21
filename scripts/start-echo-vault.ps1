# Compatibility entry for existing shortcuts.
param([switch]$Check, [ValidateRange(1,65535)][int]$Port = 8765)
& (Join-Path $PSScriptRoot 'start-gpt-vault.ps1') @PSBoundParameters
exit $LASTEXITCODE
