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
}finally{Remove-Item -LiteralPath $testRoot -Recurse -Force}
[Console]::Out.WriteLine((@{passed=$passed;failed=0;scope='PowerShell production functions with isolated OS fixtures; no real network writes'}|ConvertTo-Json -Compress))
