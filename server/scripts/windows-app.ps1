param([ValidateSet('inspect', 'start', 'browser', 'stop')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$closeRequested = 0
# PowerShell may coerce ISO strings to DateTime; compare the original UTC
# precision rather than its locale-dependent implicit string representation.
foreach ($owned in $request.owned) {
    if ($owned.startedAt -is [datetime]) { $owned.startedAt = $owned.startedAt.ToUniversalTime().ToString('O') }
}

function Find-Figma {
    if ($request.path) {
        $candidate = [System.IO.Path]::GetFullPath([string]$request.path)
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf) -or [System.IO.Path]::GetFileName($candidate) -ine 'Figma.exe') {
            throw 'APP_NOT_FOUND: --path 必须指向 Figma.exe'
        }
        return $candidate
    }
    $command = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\figma\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
    if ($command -match '^"([^"]+\.exe)"') {
        if (Test-Path -LiteralPath $Matches[1] -PathType Leaf) { return $Matches[1] }
    }
    $candidate = Join-Path $env:LOCALAPPDATA 'Figma\Figma.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    return $null
}

function Figma-Processes([string]$installPath) {
    if (!$installPath) { return @() }
    $installRoot = Split-Path -Parent $installPath
    if ((Split-Path -Leaf $installRoot) -like 'app-*') { $installRoot = Split-Path -Parent $installRoot }
    $prefix = [System.IO.Path]::GetFullPath($installRoot).TrimEnd('\') + '\'
    $session = (Get-Process -Id $PID).SessionId
    $items = @(Get-CimInstance Win32_Process -Filter "Name = 'Figma.exe'" | Where-Object {
        $_.SessionId -eq $session -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    $ids = @($items | ForEach-Object { [int]$_.ProcessId })
    return @($items | ForEach-Object {
        [pscustomobject]@{ pid = [int]$_.ProcessId; path = $_.ExecutablePath; startedAt = $_.CreationDate.ToUniversalTime().ToString('O'); root = [int]$_.ParentProcessId -notin $ids }
    })
}

function Launch([string]$executable, [string]$argument) {
    # ShellExecute launches a GUI process independently. Inheriting stdio or
    # PowerShell's redirected-output pumps can keep our JSON pipes open for the
    # application's entire lifetime. ArgumentList still passes exactly one URL.
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $executable
    $startInfo.UseShellExecute = $true
    # This is the interactive application the user asked to open, not our
    # background helper. Hiding it also prevents CloseMainWindow from working.
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
    if ($argument) { $startInfo.ArgumentList.Add($argument) }
    $started = [Diagnostics.Process]::Start($startInfo)
    if (!$started) { throw 'APP_START_FAILED: 启动失败' }
    $started.Dispose()
}

try {
    if ($Action -eq 'browser') {
        if ($request.browser -eq 'default') {
            $startInfo = [Diagnostics.ProcessStartInfo]::new([string]$request.url)
            $startInfo.UseShellExecute = $true
            $started = [Diagnostics.Process]::Start($startInfo)
            if ($started) { $started.Dispose() }
        } else {
            $name = if ($request.browser -eq 'chrome') { 'chrome.exe' } else { 'msedge.exe' }
            $browserPath = $null
            foreach ($root in @('Registry::HKEY_CURRENT_USER', 'Registry::HKEY_LOCAL_MACHINE')) {
                $key = "$root\Software\Microsoft\Windows\CurrentVersion\App Paths\$name"
                $candidate = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'(default)'
                if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $browserPath = $candidate; break }
            }
            if (!$browserPath) { throw 'BROWSER_NOT_FOUND: 未找到指定浏览器' }
            Launch $browserPath $request.url
        }
        @{ opened = $true; target = 'browser'; url = $request.url; browser = $request.browser; managed = $false } | ConvertTo-Json -Compress
        exit 0
    }
    $installPath = Find-Figma
    $processes = @(Figma-Processes $installPath)
    if ($Action -eq 'inspect') {
        @{ path = $installPath; installed = [bool]$installPath; running = ($processes.Count -gt 0); processes = $processes } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }
    if (!$installPath) { throw 'APP_NOT_FOUND: 未安装 Figma；可使用 --path 指定 Figma.exe' }
    if ($Action -eq 'start') {
        $existing = $processes.Count -gt 0
        if (!$existing -or $request.url) { Launch $installPath $request.url }
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            Start-Sleep -Milliseconds 250
            $after = @(Figma-Processes $installPath)
            if ($after.Count -gt 0) { break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if (!$after.Count) { throw 'APP_START_FAILED: 启动后未检测到 Figma 进程' }
        @{ opened = $true; target = 'desktop'; path = $installPath; running = $true; wasRunning = $existing; reused = $existing; processes = $after; owned = @($after | Where-Object { !$existing -and $_.root }) } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }
    $targets = @($processes | Where-Object {
        $process = $_
        $_.root -and ($request.all -or @($request.owned | Where-Object {
            $_.pid -eq $process.pid -and $_.path -ieq $process.path -and $_.startedAt -eq $process.startedAt
        }).Count -gt 0)
    })
    if (!$targets.Count) {
        if ($processes.Count) { throw 'APP_NOT_OWNED: 未找到 CLI 启动的实例；要关闭已有实例请显式使用 --all' }
        @{ stopped = $true; alreadyStopped = $true } | ConvertTo-Json -Compress
        exit 0
    }
    foreach ($target in $targets) {
        $process = Get-Process -Id $target.pid -ErrorAction SilentlyContinue
        if ($process) {
            if ($process.CloseMainWindow()) { $closeRequested++ }
            $process.Dispose()
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $remaining = @(Figma-Processes $installPath | Where-Object {
            $current = $_
            @($targets | Where-Object { $_.pid -eq $current.pid -and $_.startedAt -eq $current.startedAt -and $_.path -ieq $current.path }).Count -gt 0
        })
        if (!$remaining.Count) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count -and !$request.force) { throw 'APP_CLOSE_BLOCKED: 正常关闭后仍有 Figma 进程；窗口关闭不代表后台进程退出，请检查应用或显式使用 --force' }
    if ($remaining.Count) {
        foreach ($target in $remaining) {
            # Revalidate PID, executable and start time immediately before terminating this app tree.
            $valid = @(Figma-Processes $installPath | Where-Object { $_.pid -eq $target.pid -and $_.startedAt -eq $target.startedAt -and $_.path -ieq $target.path })
            if ($valid.Count) {
                $process = Get-Process -Id $target.pid -ErrorAction Stop
                $process.Kill($true)
                if (!$process.WaitForExit(5000)) { throw 'APP_CLOSE_BLOCKED: 强制关闭后进程仍存在' }
                $process.Dispose()
            }
        }
    }
    @{ stopped = $true; forced = [bool]($remaining.Count); pids = @($targets.pid); windowCloseRequested = $closeRequested } | ConvertTo-Json -Compress
} catch {
    @{ error = $_.Exception.Message; details = @{ windowCloseRequested = $closeRequested; remainingPids = @($remaining.pid) } } | ConvertTo-Json -Depth 5 -Compress
    exit 1
}
