param([switch]$Check, [ValidateRange(1,65535)][int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot

try {
    if ($project -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
        $distribution = $Matches[1]
        $linuxProject = '/' + $Matches[2].Replace('\', '/')
        if ($Check) {
            @{ mode = 'wsl'; distribution = $distribution; project = $linuxProject; binaryExists = (Test-Path (Join-Path $project 'bin\gpt-vault')) } | ConvertTo-Json -Compress
            exit 0
        }
        & wsl.exe --distribution $distribution --cd $linuxProject --exec bash ./scripts/start-gpt-vault.sh --port $Port
        exit $LASTEXITCODE
    }

    $binary = Join-Path $project 'bin\gpt-vault.exe'
    if ($Check) {
        @{ mode = 'windows'; project = $project; binaryExists = (Test-Path $binary) } | ConvertTo-Json -Compress
        exit 0
    }
    if (!(Test-Path $binary)) { throw 'Build bin\gpt-vault.exe first. See docs\guide.md.' }
    $allowedPaths = @($binary, (Join-Path $project 'bin\echo-vault.exe'))
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    $running = @($owners | ForEach-Object { Get-Process -Id $_ -ErrorAction Stop })
    foreach ($instance in $running) {
        if (!$instance.Path -or $instance.Path -notin $allowedPaths) {
            throw "Port $Port is occupied by another application or another project. It will not be stopped."
        }
    }
    if ($running.Count) {
        Write-Host 'Restarting GPT Vault...'
        foreach ($instance in $running) {
            Stop-Process -InputObject $instance -ErrorAction Stop
            if (!$instance.WaitForExit(15000)) { throw 'GPT Vault did not stop within 15 seconds.' }
        }
    }
    Push-Location $project
    try { & $binary --open-browser --port $Port; $result = $LASTEXITCODE } finally { Pop-Location }
    exit $result
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
