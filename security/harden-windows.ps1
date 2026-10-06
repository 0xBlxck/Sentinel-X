# Durcissement du PC serveur Windows (a lancer en administrateur).
# Autorise uniquement le sous-reseau de table vers les ports Sentinel-X.
param([string]$Subnet = "192.168.10.0/24")

$rules = @(
  @{ Name = "SentinelX-MQTTS";  Port = 8883 },
  @{ Name = "SentinelX-API";    Port = 8000 },
  @{ Name = "SentinelX-Camera"; Port = 8090 }
)
foreach ($r in $rules) {
  Remove-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP -LocalPort $r.Port `
    -RemoteAddress $Subnet -Action Allow | Out-Null
}
# Pare-feu actif et bloquant par defaut sur tous les profils
Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block
Write-Host "Pare-feu configure : seuls $Subnet -> 8883/8000/8090 sont autorises."
