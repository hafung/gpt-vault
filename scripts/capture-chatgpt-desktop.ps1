# Invoked by GPT Vault, with a JSON job list on stdin. Only compact JSON records
# are written to stdout. This helper does not start, restart or navigate Desktop.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:socket = $null
$script:sequence = 0
$phase = 'input'

function Write-Record($value) {
    [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 100 -Compress))
    [Console]::Out.Flush()
}

function Read-ModuleName([string]$executable) {
    $archive = Join-Path (Split-Path -Parent $executable) 'resources\app.asar'
    $stream = [IO.File]::Open($archive, 'Open', 'Read', 'ReadWrite')
    try {
        $reader = New-Object IO.BinaryReader($stream)
        $header = $reader.ReadBytes(16)
        if ($header.Length -ne 16) { throw 'Invalid archive header' }
        $length = [BitConverter]::ToUInt32($header, 12)
        if ($length -gt 16777216) { throw 'Archive header too large' }
        $bytes = $reader.ReadBytes($length)
        if ($bytes.Length -ne $length) { throw 'Truncated archive header' }
        $index = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        $names = @($index.files.webview.files.assets.files.PSObject.Properties.Name | Where-Object { $_ -match '^chatgpt-request-[a-zA-Z0-9]+\.js$' })
        if ($names.Count -ne 1) { throw 'Unsupported Desktop request module' }
        $request = '/assets/' + $names[0]
        $bindings = $null
        try {
            $base = 8 + [BitConverter]::ToUInt32($header, 4)
            $entry = $index.files.webview.files.assets.files.PSObject.Properties[$names[0]].Value
            [void]$stream.Seek($base + [long]$entry.offset, 'Begin')
            $requestText = [Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$entry.size))
            $initial = [regex]::Match($requestText, '\./(app-initial-[a-zA-Z0-9]+\.js)').Groups[1].Value
            $entry = $index.files.webview.files.assets.files.PSObject.Properties[$initial].Value
            [void]$stream.Seek($base + [long]$entry.offset, 'Begin')
            $source = [Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$entry.size))
            # Resolve minified exports by the native functions' behavior, rather
            # than pinning build-specific symbol names. No bundled code is run here.
            $download = [regex]::Match($source, 'async function ([\w$]+)\([^)]*\)\{[\s\S]{0,600}?\.getInstance\(\)\.fetch\(\w+\.downloadUrl').Groups[1].Value
            $resolver = [regex]::Match($source, 'function ([\w$]+)\([^)]*\)\{[^{}]{0,100}return\{cacheKey:\[`chatgpt-conversation`').Groups[1].Value
            $sandbox = [regex]::Match($source, 'async function ([\w$]+)\(\{conversationId:[^)]{0,400}sandboxPath:[^)]{0,400}\)\{[\s\S]{0,1500}?/interpreter/download').Groups[1].Value
            if (!$resolver) { $resolver = [regex]::Match($source, 'function ([\w$]+)\([^)]*\)\{[^{}]{0,150}return\{cacheKey:\[`chatgpt-conversation`').Groups[1].Value }
            if ($download -and $resolver) {
                $downloadExport = [regex]::Match($source, '(?<![\w$])' + [regex]::Escape($download) + ' as ([\w$]+)(?=[,}])').Groups[1].Value
                $resolverExport = [regex]::Match($source, '(?<![\w$])' + [regex]::Escape($resolver) + ' as ([\w$]+)(?=[,}])').Groups[1].Value
                $sandboxExport = ''
                if ($sandbox) { $sandboxExport = [regex]::Match($source, '(?<![\w$])' + [regex]::Escape($sandbox) + ' as ([\w$]+)(?=[,}])').Groups[1].Value }
                if ($downloadExport -and $resolverExport) { $bindings = @{module=('/assets/'+$initial);download=$downloadExport;resolver=$resolverExport;sandbox=$sandboxExport} }
            }
        } catch { $bindings = $null }
        return @{request=$request;images=$bindings}
    } finally { $stream.Dispose() }
}

function Open-Cdp([string]$address, [int]$port) {
    $uri = [Uri]$address
    if ($uri.Scheme -ne 'ws' -or $uri.Host -notin @('127.0.0.1','localhost') -or $uri.Port -ne $port) { throw 'Non-local inspector address' }
    $script:socket = New-Object Net.WebSockets.ClientWebSocket
    $script:socket.Options.Proxy = $null
    $cancel = New-Object Threading.CancellationTokenSource
    $cancel.CancelAfter(5000)
    try { [void]$script:socket.ConnectAsync($uri,$cancel.Token).GetAwaiter().GetResult() } finally { $cancel.Dispose() }
}

function Invoke-Cdp([string]$expression) {
    $script:sequence++
    $request = @{ id=$script:sequence; method='Runtime.evaluate'; params=@{ expression=$expression; returnByValue=$true; awaitPromise=$true } } | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($request)
    $cancel = New-Object Threading.CancellationTokenSource
    $cancel.CancelAfter(95000)
    try {
        [void]$script:socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,$cancel.Token).GetAwaiter().GetResult()
        while ($true) {
            $output = New-Object IO.MemoryStream
            try {
                $buffer = New-Object byte[] 16384
                do {
                    $frame = $script:socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$cancel.Token).GetAwaiter().GetResult()
                    if ($frame.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'Inspector closed' }
                    $output.Write($buffer,0,$frame.Count)
                    if ($output.Length -gt 67108864) { throw 'Inspector response too large' }
                } while (!$frame.EndOfMessage)
                $response = [Text.Encoding]::UTF8.GetString($output.ToArray()) | ConvertFrom-Json
            } finally { $output.Dispose() }
            if ($response.id -ne $script:sequence) { continue }
            if ($response.error -or $response.result.exceptionDetails) { throw 'Page evaluation failed' }
            if (!$response.result.result.value) { throw 'Page returned no result' }
            return [string]$response.result.result.value
        }
    } finally { $cancel.Dispose() }
}

try {
    $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $port = [int]$inputValue.port
    if ($port -ne 19222) { throw 'Unexpected inspector port' }
    $phase = 'inspector'
    $targets = @()
    foreach ($candidatePort in @(19222,19223)) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $candidatePort -ErrorAction SilentlyContinue)
        if (!$listeners.Count -or @($listeners | Where-Object LocalAddress -notin @('127.0.0.1','::1')).Count) { continue }
        $candidateOwner = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $listeners[0].OwningProcess }
        if ($candidateOwner.Name -ne 'ChatGPT.exe' -or $candidateOwner.ExecutablePath -notmatch '[\\/]OpenAI\.[^\\/]+[\\/]app[\\/]ChatGPT\.exe$') { continue }
        $phase = 'page'
        try {
            $targets = @((Invoke-RestMethod -Uri "http://127.0.0.1:$candidatePort/json/list" -TimeoutSec 3) | Where-Object { $_.type -eq 'page' -and $_.url -match '^app://-/' -and $_.webSocketDebuggerUrl })
            if ($targets.Count) { $port=$candidatePort; $owner=$candidateOwner; break }
        } catch { }
    }
    if (!$targets.Count) { Write-Record @{kind='unavailable';error=$phase}; exit 0 }
    $phase = 'module'
    $modules = Read-ModuleName $owner.ExecutablePath
    $module = $modules.request
    $phase = 'connection'
    Open-Cdp $targets[0].webSocketDebuggerUrl $port
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 90000
    if ($inputValue.discover) {
        $discovery = @'
(async()=>{
  try{
    if(location.origin!=='app://-')throw Error('Unexpected page');
    const {Request}=await import(__MODULE__);
    const list=await Request.safeGet('/conversations',{parameters:{query:{offset:0,limit:20,order:'updated',is_archived:false,expand:false,exclude_conversation_origin:'tpp'}},additionalHeaders:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
    if(!Array.isArray(list.items))throw Error('Invalid list');
    return JSON.stringify({kind:'recent',recent:list.items.slice(0,20).map(c=>({id:c.id,title:c.title,update_time:c.update_time}))});
  }catch(error){return JSON.stringify({kind:'error',status:error.responseStatus||error.status||0})}
})()
'@
        $expression = $discovery.Replace('__MODULE__',($module | ConvertTo-Json -Compress))
        [Console]::Out.WriteLine((Invoke-Cdp $expression))
        [Console]::Out.Flush()
        exit 0
    }
    $template = [string]$inputValue.conversation_script
    $imageBudget = 16777216
    foreach ($job in $inputValue.jobs) {
        if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline - 2000) { break }
        if ($job.id -notmatch '^[a-zA-Z0-9-]{1,128}$') { throw 'Invalid conversation ID' }
        $expression = $template.Replace('__JOB__',($job | ConvertTo-Json -Depth 20 -Compress)).Replace('__MODULE__',($module | ConvertTo-Json -Compress)).Replace('__DEADLINE__',[string]$deadline)
        try {
            $value = Invoke-Cdp $expression
            # Send the page's already encoded JSON directly; ConvertTo-Json would
            # otherwise truncate deeply nested message metadata in PowerShell 5.
            [Console]::Out.WriteLine($value)
            [Console]::Out.Flush()
            $record = $value | ConvertFrom-Json
            if (($record.kind -eq 'conversation' -or $job.images.Count -or $job.files.Count) -and $inputValue.images_script) {
              try {
                $arguments = '{job:' + ($job | ConvertTo-Json -Depth 20 -Compress) + ',conversation:(' + $value + ').conversation,bindings:' + ($modules.images | ConvertTo-Json -Compress) + ',deadline:' + $deadline + ',budget:' + $imageBudget + '}'
                $media = Invoke-Cdp ('(' + $inputValue.images_script + ')(' + $arguments + ')')
                [Console]::Out.WriteLine($media)
                [Console]::Out.Flush()
                $imageBudget -= [int](($media | ConvertFrom-Json).bytes)
              } catch { Write-Record @{kind='images';id=$job.id;images=@();files=@();pending_images=1;pending_files=$job.files.Count} }
            }
        } catch { Write-Record @{kind='error';id=$job.id;status=0} }
    }
} catch { Write-Record @{kind='unavailable';error=$phase} }
finally { if ($script:socket) { $script:socket.Dispose() } }
