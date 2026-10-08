# Durcissement du PC serveur Sentinel-X (lancer en administrateur).
#   .\harden-windows.ps1              reseau de table detecte automatiquement (interface de la route par defaut)
#   .\harden-windows.ps1 -Subnet 172.20.10.0/28   reseau impose
#   .\harden-windows.ps1 -DryRun      affiche ce qui serait applique, sans rien modifier (pas besoin d'admin)
#   .\harden-windows.ps1 -Undo        retire les regles Sentinel-X
param(
    [string]$Subnet = "",
    [switch]$DryRun,
    [switch]$Undo
)

# Reseau de demo : partage de connexion de l'iPhone (PC serveur 172.20.10.12, ESP 172.20.10.13)
$DefaultSubnet = "172.20.10.0/28"

# BlockMSQL : ancien nom, remplace par BlockDB (garde ici pour le nettoyage)
$sentinelRules = @("SentinelX-MQTTS", "SentinelX-API", "SentinelX-Camera",
                   "SentinelX-BlockCUPS", "SentinelX-BlockDB", "SentinelX-BlockMSQL")

if ($Undo) {
    $sentinelRules | ForEach-Object { Remove-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue }
    Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultInboundAction NotConfigured
    Write-Host "Regles Sentinel-X supprimees."
    exit
}

# Sous-reseau de l'interface qui porte la route par defaut (Wi-Fi de table), ex. 172.20.10.12/28 -> 172.20.10.0/28
function Get-TableSubnet {
    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
    if (-not $route) { return $null }
    $ip = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1
    if (-not $ip) { return $null }
    $bytes = ([System.Net.IPAddress]::Parse($ip.IPAddress)).GetAddressBytes()
    [Array]::Reverse($bytes)
    $addr = [BitConverter]::ToUInt32($bytes, 0)
    $mask = if ($ip.PrefixLength -eq 0) { [uint32]0 } else { [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $ip.PrefixLength)) }
    $net = [BitConverter]::GetBytes([uint32]($addr -band $mask))
    [Array]::Reverse($net)
    return [pscustomobject]@{
        Subnet    = "$([System.Net.IPAddress]::new($net))/$($ip.PrefixLength)"
        Interface = $route.InterfaceAlias
        Address   = $ip.IPAddress
    }
}

if (-not $Subnet) {
    $found = Get-TableSubnet
    if ($found) {
        $Subnet = $found.Subnet
        Write-Host "Reseau detecte : $Subnet (interface $($found.Interface), PC $($found.Address))"
    } else {
        $Subnet = $DefaultSubnet
        Write-Host "Aucun reseau detecte : reseau de demo par defaut $Subnet"
    }
}

# Ports du projet, ouverts UNIQUEMENT au reseau de table
$allow = @(
    @{ Name = "SentinelX-MQTTS";  Port = 8883; Role = "MQTT/TLS (ESP)" },
    @{ Name = "SentinelX-API";    Port = 8000; Role = "API + dashboard" },
    @{ Name = "SentinelX-Camera"; Port = 8090; Role = "flux camera" }
)
# Bloques depuis partout (une regle Block l'emporte sur une Allow, y compris celles de Docker)
$block = @(
    @{ Name = "SentinelX-BlockCUPS"; Ports = @(631);              Role = "impression CUPS" },
    @{ Name = "SentinelX-BlockDB";   Ports = @(1433, 3306, 5432); Role = "bases de donnees (MSSQL, MySQL, PostgreSQL)" }
)

if ($DryRun) {
    Write-Host "`n[simulation] rien n'est modifie"
    $allow | ForEach-Object { Write-Host ("  autoriser {0,-5} {1,-17} depuis {2}" -f $_.Port, $_.Role, $Subnet) }
    $block | ForEach-Object { Write-Host ("  bloquer   {0,-17} {1}" -f ($_.Ports -join ","), $_.Role) }
    Write-Host "  pare-feu actif, entrees bloquees par defaut sur tous les profils"
    exit
}

$sentinelRules | ForEach-Object { Remove-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue }
foreach ($r in $allow) {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP `
        -LocalPort $r.Port -RemoteAddress $Subnet -Action Allow | Out-Null
}
foreach ($r in $block) {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP `
        -LocalPort $r.Ports -RemoteAddress Any -Action Block | Out-Null
}

# Pare-feu actif, tout le reste bloque en entree
Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block

Write-Host "OK : pare-feu configure pour Sentinel-X"
Write-Host "  Autorise depuis $Subnet : 8883 (MQTT), 8000 (API), 8090 (camera)"
Write-Host "  Bloque : 631 (CUPS), 1433/3306/5432 (bases de donnees), tout le reste"
