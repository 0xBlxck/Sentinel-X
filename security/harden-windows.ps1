# Durcissement du PC serveur Sentinel-X (lancer en administrateur).
param(
    [string]$Subnet = "10.60.60.0/22",
    [switch]$Undo
)

$sentinelRules = @("SentinelX-MQTTS","SentinelX-API","SentinelX-Camera","SentinelX-BlockCUPS","SentinelX-BlockMSQL")

if ($Undo) {
    $sentinelRules | ForEach-Object { Remove-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue }
    Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultInboundAction NotConfigured
    Write-Host "Regles Sentinel-X supprimees."
    exit
}

# Supprimer anciennes regles
$sentinelRules | ForEach-Object { Remove-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue }

# Autoriser ports projet UNIQUEMENT depuis le reseau de table
$allow = @(
  @{ Name = "SentinelX-MQTTS";  Port = 8883 },
  @{ Name = "SentinelX-API";    Port = 8000 },
  @{ Name = "SentinelX-Camera"; Port = 8090 }
)
foreach ($r in $allow) {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP `
        -LocalPort $r.Port -RemoteAddress $Subnet -Action Allow | Out-Null
}

# Bloquer explicitement CUPS (631) depuis l'exterieur
New-NetFirewallRule -DisplayName "SentinelX-BlockCUPS" -Direction Inbound -Protocol TCP `
    -LocalPort 631 -RemoteAddress Any -Action Block | Out-Null

# Activer le pare-feu avec blocage par defaut
Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block

Write-Host "OK : pare-feu configure pour Sentinel-X"
Write-Host "  Autorise depuis $Subnet : 8883 (MQTT), 8000 (API), 8090 (camera)"
Write-Host "  Bloque : 631 (CUPS), tout le reste"
