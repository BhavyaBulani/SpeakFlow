$os = Get-CimInstance Win32_OperatingSystem
$freeMB = [math]::Round($os.FreePhysicalMemory / 1KB)
$totalMB = [math]::Round($os.TotalVisibleMemorySize / 1KB)
Write-Output "Free physical: $freeMB MB / $totalMB MB"

$a = Get-CimInstance Win32_OperatingSystem
$commitLimit = [math]::Round($a.TotalVirtualMemorySize / 1KB)
$commitUsed = [math]::Round(($a.TotalVirtualMemorySize - $a.FreeVirtualMemory) / 1KB)
Write-Output "Commit: $commitUsed MB used / $commitLimit MB limit"

Write-Output ""
Write-Output "Top consumers:"
Get-Process | Group-Object ProcessName | ForEach-Object {
    [pscustomobject]@{
        Name  = $_.Name
        Count = $_.Count
        MB    = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)
    }
} | Sort-Object MB -Descending | Select-Object -First 12 | Format-Table -AutoSize
