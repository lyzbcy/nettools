$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=Get-Acl -LiteralPath ([string]$request.file)
$owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
$trusted=@($current,'S-1-5-18','S-1-5-32-544','S-1-3-0')
$otherReaders=0
foreach($rule in $acl.Access){
    if($rule.AccessControlType -ne 'Allow'){continue}
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if($sid -notin $trusted -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0)){$otherReaders++}
}
$result=@{ok=($owner -in $trusted -and $otherReaders -eq 0);ownerTrusted=($owner -in $trusted);otherReaders=$otherReaders}
[Console]::Out.WriteLine(($result|ConvertTo-Json -Compress))
if(!$result.ok){exit 1}
