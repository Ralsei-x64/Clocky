$gpu = $null
$battery = $null
$charging = $false
$pluggedIn = $false
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $power = [System.Windows.Forms.SystemInformation]::PowerStatus
    $pluggedIn = $power.PowerLineStatus -eq [System.Windows.Forms.PowerLineStatus]::Online
    $status = $power.BatteryChargeStatus
    if ($status -ne 'Unknown' -and -not $status.HasFlag([System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery)) {
        $level = $power.BatteryLifePercent
        if ($level -ge 0 -and $level -le 1) { $battery = [math]::Round($level * 100) }
        $charging = $status.HasFlag([System.Windows.Forms.BatteryChargeStatus]::Charging)
    }
} catch {}
try {
    $engines = @{}
    $readings = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop
    foreach ($reading in $readings) {
        $engine = $reading.Name -replace '^pid_\d+_', ''
        $engines[$engine] += [double]$reading.UtilizationPercentage
    }
    if ($engines.Count) { $gpu = [math]::Min(100, ($engines.Values | Measure-Object -Maximum).Maximum) }
} catch {}
@{ gpu = $gpu; battery = $battery; charging = $charging; pluggedIn = $pluggedIn } | ConvertTo-Json -Compress
