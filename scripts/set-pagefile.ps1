# Raises the Windows commit limit so processes stop being terminated under memory
# pressure. Must be run from an ELEVATED (Administrator) PowerShell window.
#
# Why: physical RAM is 16 GB but running programs commit ~21 GB. The commit limit
# (RAM + page file, currently ~24 GB) is what Windows enforces. When it is nearly
# reached, Windows kills whatever it needs to -- e.g. an IDE session actor.
# Growing the page file raises the limit; nothing has to be closed.

$ErrorActionPreference = 'Stop'

# Initial size should be large enough to cover current demand; maximum allows growth.
$initialMB = 16384
$maximumMB = 32768

$cs = Get-CimInstance -ClassName Win32_ComputerSystem

if ($cs.AutomaticManagedPagefile) {
    Write-Host 'Disabling automatically managed page file...'
    Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false }
}

$path = 'C:\pagefile.sys'
$pf = Get-CimInstance -ClassName Win32_PageFileSetting |
    Where-Object { $_.Name -eq $path }

if ($pf) {
    Write-Host "Resizing $path to $initialMB MB initial / $maximumMB MB max..."
    Set-CimInstance -InputObject $pf -Property @{
        InitialSize = $initialMB
        MaximumSize = $maximumMB
    }
}
else {
    Write-Host "Creating $path at $initialMB MB initial / $maximumMB MB max..."
    New-CimInstance -ClassName Win32_PageFileSetting -Property @{
        Name        = $path
        InitialSize = $initialMB
        MaximumSize = $maximumMB
    }
}

Write-Host ''
Write-Host 'Result:'
Get-CimInstance -ClassName Win32_PageFileSetting |
    Select-Object Name, InitialSize, MaximumSize |
    Format-List

Write-Host 'Reboot for the new commit limit to take effect.'
