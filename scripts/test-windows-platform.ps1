$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\src\platform\windows-network.ps1') -Library
$passed=0
function Check([bool]$Condition,[string]$Message){if(!$Condition){throw ('FAILED: '+$Message)};$script:passed++}
function Expect-Code([scriptblock]$Action,[string]$Expected){try{& $Action;throw 'Expected a failure'}catch{Check ($_.Exception.Data['code'] -eq $Expected) ('error code '+$Expected)}}
Check (Valid-Ip '223.5.5.5') 'valid IPv4'
Check (Valid-Ip '2001:4860:4860::8888') 'valid IPv6'
Check (!(Valid-Ip '999.1.1.1')) 'reject bad octet'
Check (!(Valid-Ip '1.1.1.1; whoami')) 'reject command text'
Check (Valid-Domain 'git.corp.example') 'valid domain'
Check (!(Valid-Domain '../outside')) 'reject resolver path'

function Active-Identity{return @{index=7;guid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';iface='Ethernet';physical=$true;dhcp=$false}}
function Get-NetIPInterface{return @{Dhcp='Disabled'}}
Expect-Code {Renew-DHCP} 'STATIC_IP'
Expect-Code {Validate-Config @{company=@{};vpn=@{configName='/disconnect'};windows=@{}}} 'INVALID_CONFIG'

# Register isolated WebRequest factories so this test exercises the production
# HTTP handling without reaching an external host.
Add-Type @'
using System;
using System.Net;
public sealed class NetToolsProxy407Factory : IWebRequestCreate {
 public WebRequest Create(Uri uri) { return new NetToolsProxy407Request(); }
}
public sealed class NetToolsProxy407Request : WebRequest {
 public override int Timeout {get;set;}
 public int ReadWriteTimeout {get;set;}
 public string UserAgent {get;set;}
 public override IWebProxy Proxy {get;set;}
 public override WebResponse GetResponse() { throw new WebException("Proxy authentication required",null,WebExceptionStatus.ProtocolError,new NetToolsProxy407Response()); }
 public override void Abort() {}
}
public sealed class NetToolsProxy407Response : WebResponse {
 public HttpStatusCode StatusCode {get{return HttpStatusCode.ProxyAuthenticationRequired;}}
 public override void Close() {}
}
'@ -IgnoreWarnings -WarningAction SilentlyContinue
$factory=New-Object NetToolsProxy407Factory
$null=[Net.WebRequest]::RegisterPrefix('https://www.baidu.com/',$factory)
$null=[Net.WebRequest]::RegisterPrefix('https://www.qq.com/',$factory)
Check (!(Test-Web)) 'proxy 407 is not public HTTPS success'
function Active-Identity{return @{index=7;guid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';iface='Ethernet';physical=$true;dhcp=$true;ip='192.0.2.10';hasRoute=$true;gateway='192.0.2.1'}}
function Proxy-Info{return @{enabled=$false;endpoints=@();pac='';server='';override=''}}
function Test-Dns{return $false}
function Test-Raw{return $false}
Check ((Network-Check).issue -eq 'dns') 'blocked ICMP cannot turn DNS failure into DHCP repair'

$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('nettools-win-fixture-'+[guid]::NewGuid().ToString())
$null=[IO.Directory]::CreateDirectory($testRoot)
try{
    $file=Join-Path $testRoot 'pending.json'
    $first=Pending-Snapshot $file @{original='before-repair'}
    $second=Pending-Snapshot $file @{original='already-modified'}
    Check ($second.original -eq 'before-repair') 'repeated repair preserves original snapshot'
    $first.pending=$false;Write-Json $file $first
    $fresh=Pending-Snapshot $file @{original='new-baseline'}
    Check ($fresh.original -eq 'new-baseline') 'a completed snapshot may be renewed'

    $script:mutations=New-Object Collections.Generic.List[object]
    function Get-NetAdapter{param([int]$InterfaceIndex);return @{InterfaceGuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}}
    function Get-DnsClientServerAddress{param([int]$InterfaceIndex,[string]$AddressFamily);return @{InterfaceIndex=$InterfaceIndex;AddressFamily=$AddressFamily;ServerAddresses=@()}}
    function Set-DnsClientServerAddress{param($InputObject,[switch]$ResetServerAddresses,[string[]]$ServerAddresses,[int]$InterfaceIndex);$script:mutations.Add(@{family=$InputObject.AddressFamily;automatic=[bool]$ResetServerAddresses;servers=$ServerAddresses})}
    function Clear-DnsClientCache{}
    $snapshot=@{index=7;guid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';families=@{IPv4=@{automatic=$true;servers=@('10.1.1.1')};IPv6=@{automatic=$false;servers=@('2001:db8::1','2001:db8::2')}}}
    Restore-DNS $snapshot
    Check ($script:mutations.Count -eq 2) 'restore checks both address families'
    Check ($script:mutations[0].automatic -eq $true) 'restore automatic IPv4'
    Check (($script:mutations[1].servers -join ',') -eq '2001:db8::1,2001:db8::2') 'preserve every original IPv6 DNS'

    $script:mutations.Clear()
    function DNS-Snapshot{return @{index=7;guid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';families=@{IPv4=@{automatic=$false;servers=@('9.9.9.9')};IPv6=@{automatic=$true;servers=@()}}}}
    function Resolve-DnsName{throw 'unreachable DNS'}
    Expect-Code {Apply-DNS @{primary='1.1.1.1';secondary=''} $testRoot} 'DNS_ROLLED_BACK'
    Check ($script:mutations.Count -eq 3) 'bad DNS application followed by two-family restore'
    Check (($script:mutations[1].servers -join ',') -eq '9.9.9.9') 'failed DNS really restores original IPv4'
    Check ((Read-Json (Join-Path $testRoot 'dns-backup.json')).pending -eq $true) 'failed change retains its original recovery point'
    function Set-DnsClientServerAddress{throw 'write and rollback denied'}
    Expect-Code {Apply-DNS @{primary='1.1.1.1';secondary=''} $testRoot} 'ROLLBACK_FAILED'

    # A model of the kernel route table and NRPT exercises the production VPN
    # transaction, including both default-route families and write-ahead failure.
    $script:routes=New-Object Collections.Generic.List[object]
    $script:rules=New-Object Collections.Generic.List[object]
    $script:proxyOverride=''
    function Get-NetAdapter{param([int]$InterfaceIndex,[string]$Name)
        $all=@(@{Name='Ethernet';ifIndex=7;InterfaceGuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';HardwareInterface=$true;Status='Up';InterfaceType=6;InterfaceDescription='Ethernet'},@{Name='CorpVPN';ifIndex=77;InterfaceGuid='bbbbbbbb-cccc-dddd-eeee-ffffffffffff';HardwareInterface=$false;Status='Up';InterfaceType=131;InterfaceDescription='Corp VPN adapter'})
        if($PSBoundParameters.ContainsKey('InterfaceIndex')){return $all|Where-Object {$_.ifIndex -eq $InterfaceIndex}}
        return $all
    }
    function Get-NetRoute{param([int]$InterfaceIndex,[string]$DestinationPrefix,[string]$NextHop,[string]$AddressFamily)
        return @($script:routes|Where-Object {(!$PSBoundParameters.ContainsKey('InterfaceIndex') -or $_.InterfaceIndex -eq $InterfaceIndex) -and (!$DestinationPrefix -or $_.DestinationPrefix -eq $DestinationPrefix) -and (!$NextHop -or $_.NextHop -eq $NextHop) -and (!$AddressFamily -or $_.AddressFamily -eq $AddressFamily)})
    }
    function New-NetRoute{param([int]$InterfaceIndex,[string]$DestinationPrefix,[string]$NextHop,[int]$RouteMetric=1,[string]$PolicyStore)
        $entry=[pscustomobject]@{InterfaceIndex=$InterfaceIndex;DestinationPrefix=$DestinationPrefix;NextHop=$NextHop;RouteMetric=$RouteMetric;AddressFamily=$(if($DestinationPrefix.Contains(':')){'IPv6'}else{'IPv4'})}
        $script:routes.Add($entry);return $entry
    }
    function Remove-NetRoute{param([int]$InterfaceIndex,[string]$DestinationPrefix,[string]$NextHop,$InputObject,[switch]$Confirm)
        if($InputObject){$InterfaceIndex=$InputObject.InterfaceIndex;$DestinationPrefix=$InputObject.DestinationPrefix;$NextHop=$InputObject.NextHop}
        foreach($entry in @($script:routes|Where-Object {$_.InterfaceIndex -eq $InterfaceIndex -and $_.DestinationPrefix -eq $DestinationPrefix -and $_.NextHop -eq $NextHop})){$null=$script:routes.Remove($entry)}
    }
    function Get-DnsClientNrptRule{param([string]$Name);if($Name){return @($script:rules|Where-Object {$_.Name -eq $Name})};return $script:rules.ToArray()}
    function Add-DnsClientNrptRule{param([string[]]$Namespace,[string[]]$NameServers,[string]$DisplayName,[string]$Comment,[switch]$PassThru)
        $entry=[pscustomobject]@{Name=[guid]::NewGuid().ToString();Namespace=$Namespace;DisplayName=$DisplayName;Comment=$Comment};$script:rules.Add($entry);return $entry
    }
    function Remove-DnsClientNrptRule{param([string]$Name,[switch]$Force);foreach($entry in @($script:rules|Where-Object {$_.Name -eq $Name})){$null=$script:rules.Remove($entry)}}
    function Proxy-Info{return @{enabled=$false;endpoints=@();pac='';server='';override=$script:proxyOverride}}
    function Set-ItemProperty{param([string]$LiteralPath,[string]$Name,$Value);if($Name -eq 'ProxyOverride'){$script:proxyOverride=[string]$Value}}
    function Find-NetRoute{param([string]$RemoteIPAddress);$prefix=if($RemoteIPAddress.Contains(':')){'::/0'}else{'0.0.0.0/0'};return @($script:routes|Where-Object {$_.DestinationPrefix -eq $prefix -and $_.InterfaceIndex -eq 7}|Select-Object -First 1)}
    $config=@{company=@{name='Example';intranetCIDR='10.0.0.0/8';intranetDNS=@('10.8.0.53','2001:db8::53');resolverDomain='corp.example';internalHost='git.corp.example';internalProbeIP='10.8.0.7'};vpn=@{enabled=$true;configName='CorpVPN'};windows=@{adapterName='CorpVPN'}}
    foreach($entry in @(@{index=7;prefix='0.0.0.0/0';gateway='192.0.2.1'},@{index=7;prefix='::/0';gateway='fe80::1'},@{index=77;prefix='0.0.0.0/0';gateway='10.8.0.1'},@{index=77;prefix='::/0';gateway='::'})){$null=New-NetRoute $entry.index $entry.prefix $entry.gateway 8}
    $vpnState=Join-Path $testRoot 'vpn';$null=[IO.Directory]::CreateDirectory($vpnState)
    $result=VPN-Coexist $config 'S-1-5-21-1-2-3-1001' $vpnState
    Check ($result.allOk -eq $true) 'coexist verifies public split route'
    Check (@(Get-NetRoute -InterfaceIndex 77|Where-Object {$_.DestinationPrefix -in @('0.0.0.0/0','::/0')}).Count -eq 0) 'both VPN default route families removed'
    Check (@(Get-NetRoute -InterfaceIndex 77 -DestinationPrefix '2001:db8::53/128').Count -eq 1) 'IPv6 DNS exact VPN route installed'
    $restored=Reset-VPN 'S-1-5-21-1-2-3-1001' $vpnState
    Check ($restored.ok -eq $true) 'reset completed'
    Check (@(Get-NetRoute -InterfaceIndex 77|Where-Object {$_.DestinationPrefix -in @('0.0.0.0/0','::/0')}).Count -eq 2) 'original defaults restored'
    Check (@(Get-NetRoute -InterfaceIndex 77|Where-Object {$_.DestinationPrefix -notin @('0.0.0.0/0','::/0')}).Count -eq 0) 'all app-created exact routes removed'
    Check ($script:rules.Count -eq 0 -and $script:proxyOverride -eq '') 'original empty bypass and NRPT absence restored'
    $failureState=Join-Path $testRoot 'vpn-write-failure';$null=[IO.Directory]::CreateDirectory($failureState)
    $script:originalWriter=(Get-Command Write-Json).ScriptBlock;$script:writerCalls=0
    function Write-Json{param([string]$LiteralPath,$Value);$script:writerCalls++;if($script:writerCalls -eq 2){throw 'simulated disk write failure'};& $script:originalWriter $LiteralPath $Value}
    Expect-Code {VPN-Coexist $config 'S-1-5-21-1-2-3-1001' $failureState} 'VPN_PARTIAL'
    $disk=Read-Json (Join-Path $failureState 'vpn-backup.json')
    $changed=@(Get-NetRoute -InterfaceIndex 77|Where-Object {$_.DestinationPrefix -notin @('0.0.0.0/0','::/0')})
    Check ($changed.Count -eq 0 -or @($disk.addedRoutes).Count -ge $changed.Count) 'failed state write cannot leave an unrecorded route side effect'
}finally{Remove-Item -LiteralPath $testRoot -Recurse -Force}
[Console]::Out.WriteLine((@{passed=$passed;failed=0;scope='PowerShell production functions with isolated OS fixtures; no real network writes'}|ConvertTo-Json -Compress))
