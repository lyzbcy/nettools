param([string]$WorkerAction = '', [string]$GrantSid = '', [switch]$Library)
if ($PSVersionTable.PSEdition -ne 'Core') { $env:PSModulePath = $PSHOME + '\Modules;' + [Environment]::GetEnvironmentVariable('PSModulePath','Machine') }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$NetToolsVersion = '5.0.2'
$PrivilegedActions = @('flush-dns','set-dns','restore-dns','clear-proxy','restore-proxy','renew-dhcp','vpn-coexist','vpn-coexist-reset')

function Fail([string]$Code,[string]$Message) { $e = New-Object System.Exception($Message); $e.Data['code']=$Code; throw $e }
function Valid-Ip([string]$Value) {
    $address=$null
    if (![System.Net.IPAddress]::TryParse($Value,[ref]$address)) { return $false }
    if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { return $Value -match '^\d{1,3}(\.\d{1,3}){3}$' }
    return $Value.Length -le 80 -and $Value -notmatch '[\s;%]'
}
function Valid-Domain([string]$Value) { return $Value.Length -le 253 -and $Value -match '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' }
function Assert-Ordinary([string]$LiteralPath) {
    if (Test-Path -LiteralPath $LiteralPath) { $item=Get-Item -LiteralPath $LiteralPath -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'UNSAFE_PATH' 'Symbolic links or junctions are not allowed' } }
}
function Write-Json([string]$LiteralPath,$Value) {
    Assert-Ordinary $LiteralPath
    $temporary=$LiteralPath+'.'+[guid]::NewGuid().ToString()+'.tmp'
    try {
        $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 14 -Compress))
        $stream=New-Object IO.FileStream($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        if(Test-Path -LiteralPath $LiteralPath){[IO.File]::Replace($temporary,$LiteralPath,[NullString]::Value)}else{[IO.File]::Move($temporary,$LiteralPath)}
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Read-Json([string]$LiteralPath) {
    Assert-Ordinary $LiteralPath
    $item=Get-Item -LiteralPath $LiteralPath -Force
    if ($item.Length -gt 65536) { Fail 'INVALID_REQUEST' 'State is too large' }
    return [IO.File]::ReadAllText($LiteralPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
}
function Caller-Sid { return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function Grant-Root([string]$Sid) {
    if ($Sid -notmatch '^S-1-5-21-(\d+-){2,}\d+$') { Fail 'INVALID_SID' 'Invalid installing user' }
    return Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('LaoyuNetTools\Grants\'+$Sid)
}
function Assert-ProtectedRoot([string]$Root) {
    $cursor=Get-Item -LiteralPath $Root -Force
    for ($i=0;$i -lt 3;$i++) {
        Assert-Ordinary $cursor.FullName
        $acl=Get-Acl -LiteralPath $cursor.FullName
        $owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18','S-1-5-32-544')) { Fail 'UNSAFE_OWNER' 'Authorization folder is not administrator-owned' }
        $cursor=$cursor.Parent
    }
}
function Helper-Status {
    $sid=Caller-Sid; $grantRoot=Grant-Root $sid
    $state=@{ installed=$false; sid=$sid; version=$NetToolsVersion; requestFile=(Join-Path $grantRoot 'requests\request.json'); resultFiles=@{}; message='Unattended repair authorization is not installed' }
    foreach($a in $PrivilegedActions) { $state.resultFiles[$a]=Join-Path $grantRoot ($a+'.result.json') }
    if (!(Test-Path -LiteralPath (Join-Path $grantRoot 'grant.json'))) { return $state }
    try {
        Assert-ProtectedRoot $grantRoot
        $grant=Read-Json (Join-Path $grantRoot 'grant.json')
        $hash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $installedHash=(Get-FileHash -LiteralPath (Join-Path $grantRoot 'windows-network.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($grant.sid -ne $sid -or $grant.version -ne $NetToolsVersion -or $grant.scriptSha256 -ne $hash -or $installedHash -ne $hash) { return $state }
        foreach($a in $PrivilegedActions) {
            $task=Get-ScheduledTask -TaskPath ('\LaoyuNetTools\'+$sid+'\') -TaskName $a
            if ($task.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { return $state }
        }
        $state.installed=$true; $state.message='Unattended repair authorization is installed'
    } catch { $state.message='Authorization needs reinstalling or permission verification' }
    return $state
}
function Ordinary-Adapter($Adapter) {
    if(!$Adapter -or $Adapter.Status -ne 'Up'){return $false}
    if($Adapter.HardwareInterface){return $true}
    # Guest Ethernet adapters are ordinary local links too. Known VPN/TUN
    # adapters must not be mistaken for the physical/default repair target.
    return $Adapter.InterfaceDescription -notmatch '(?i)TAP|TUN\b|WireGuard|Tailscale|VPN|Tunnel' -and $Adapter.InterfaceType -in @(6,71)
}
function Active-Identity {
    $route=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1)
    $adapter=$null
    if ($route.Count -gt 0) { $adapter=Get-NetAdapter -InterfaceIndex $route[0].InterfaceIndex -ErrorAction SilentlyContinue }
    if (!(Ordinary-Adapter $adapter)) { $adapter=Get-NetAdapter | Where-Object { Ordinary-Adapter $_ } | Sort-Object @{Expression='HardwareInterface';Descending=$true},ifIndex | Select-Object -First 1 }
    if (!$adapter) { return @{iface='';service='';ip='';gateway='';index=0;guid='';physical=$false;dhcp=$false;hasRoute=($route.Count -gt 0)} }
    $address=Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
    $ipInterface=Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4
    return @{iface=$adapter.Name;service=$adapter.Name;ip=([string]$address.IPAddress);gateway=$(if($route.Count -gt 0){[string]$route[0].NextHop}else{''});index=[int]$adapter.ifIndex;guid=$adapter.InterfaceGuid.ToString();physical=(Ordinary-Adapter $adapter);dhcp=($ipInterface.Dhcp -eq 'Enabled');hasRoute=($route.Count -gt 0)}
}
function Test-Port([string]$HostName,[int]$Port) {
    $client=New-Object Net.Sockets.TcpClient
    try { $operation=$client.BeginConnect($HostName,$Port,$null,$null); if (!$operation.AsyncWaitHandle.WaitOne(700)) { return $false }; $client.EndConnect($operation); return $true } catch { return $false } finally { $client.Close() }
}
function Proxy-Path([string]$Sid='') {
    if ($Sid) { return 'Registry::HKEY_USERS\'+$Sid+'\Software\Microsoft\Windows\CurrentVersion\Internet Settings' }
    return 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
}
function Proxy-Info([string]$Sid='') {
    $settings=Get-ItemProperty -LiteralPath (Proxy-Path $Sid) -ErrorAction SilentlyContinue
    $items=@(); $server=[string]$settings.ProxyServer
    if ([int]$settings.ProxyEnable -eq 1 -and $server) {
        foreach($part in $server.Split(';')) {
            $entry=$part.Trim();$kind='all';if ($entry.Contains('=')) { $split=$entry.Split('=',2);$kind=$split[0];$entry=$split[1] }
            if ($entry -match '^(\[[0-9a-fA-F:]+\]|[^:;\s]+):(\d{1,5})$') {
                $hostName=$Matches[1].Trim('[',']');$port=[int]$Matches[2]
                if ($port -lt 1 -or $port -gt 65535) { continue }
                $local=$hostName -in @('localhost','127.0.0.1','::1');$reachable=$true
                if ($local) { $reachable=Test-Port $hostName $port }
                $items+=@{kind=$kind;host=$hostName;port=$port;local=$local;reachable=$reachable;entry=$part}
            }
        }
    }
    return @{enabled=([int]$settings.ProxyEnable -eq 1);endpoints=$items;pac=([string]$settings.AutoConfigURL);server=$server;override=([string]$settings.ProxyOverride)}
}
function Test-Dns {
    $operation=[Net.Dns]::BeginGetHostAddresses('www.baidu.com',$null,$null)
    try { if (!$operation.AsyncWaitHandle.WaitOne(3000)) { return $false }; return [Net.Dns]::EndGetHostAddresses($operation).Count -gt 0 } catch { return $false } finally { $operation.AsyncWaitHandle.Close() }
}
function Test-Web {
    foreach($url in @('https://www.baidu.com/','https://www.qq.com/')) {
        $response=$null;$request=[Net.HttpWebRequest]::Create($url);$request.Timeout=3500;$request.ReadWriteTimeout=3500;$request.UserAgent='LaoyuNetTools/5.0.2';$request.Proxy=[Net.WebRequest]::GetSystemWebProxy()
        try { $response=$request.GetResponse(); if([int]$response.StatusCode -ne 407){return $true} } catch [Net.WebException] { if ($_.Exception.Response) { $code=[int]$_.Exception.Response.StatusCode;$_.Exception.Response.Close();if($code -ne 407){return $true} } } finally { if($response){$response.Close()};$request.Abort() }
    }
    return $false
}
function Test-Raw {
    $ping=New-Object Net.NetworkInformation.Ping
    try { if($ping.Send('223.5.5.5',1800).Status -eq 'Success'){return $true} } catch {} finally { $ping.Dispose() }
    return (Test-Port '223.5.5.5' 53) -or (Test-Port '1.1.1.1' 443)
}
function Network-Check {
    $identity=Active-Identity;$proxy=Proxy-Info;$hasLink=$identity.physical -and (Valid-Ip $identity.ip)
    $dns=Test-Dns;$web=Test-Web;$raw=Test-Raw
    $stale=@($proxy.endpoints | Where-Object { $_.local -and !$_.reachable })
    $issue='http'
    if ($web) { $issue='ok' }
    elseif (!$hasLink) { $issue='no-link' }
    elseif ($stale.Count -gt 0) { $issue='stale-proxy' }
    elseif (!$identity.hasRoute) { $issue='no-route' }
    elseif (!$dns) { $issue='dns' }
    return @{ok=($issue -eq 'ok');issue=$issue;interface=$identity.iface;service=$identity.service;ip=$identity.ip;gateway=$identity.gateway;rawOk=$raw;dnsOk=$dns;httpOk=$web;dhcp=$identity.dhcp;proxyEnabled=$proxy.enabled;proxyReachable=($stale.Count -eq 0);proxyEndpoints=$proxy.endpoints;os=[Environment]::OSVersion.VersionString}
}
function Load-Config([string]$ConfigDirectory) {
    $file=Join-Path $ConfigDirectory 'config.json';Assert-Ordinary $ConfigDirectory
    if (Test-Path -LiteralPath $file) { return Read-Json $file }
    return @{company=@{name='';intranetCIDR='';intranetDNS=@();resolverDomain='';internalHost='';internalProbeIP=''};vpn=@{enabled=$false;configName='';clientAppPath='/Applications/Tunnelblick.app'};windows=@{adapterName=''}}
}
function Validate-Config($Config) {
    if (!$Config.company -or !$Config.vpn) { Fail 'INVALID_CONFIG' 'Missing company or VPN configuration' }
    $c=$Config.company
    if ($c.intranetCIDR) { $pair=$c.intranetCIDR.Split('/');if ($pair.Count -ne 2 -or $pair[0] -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or !(Valid-Ip $pair[0]) -or $pair[1] -notmatch '^(\d|[12]\d|3[0-2])$') { Fail 'INVALID_CONFIG' 'Invalid intranet CIDR' } }
    foreach($dns in @($c.intranetDNS)) { if (!(Valid-Ip ([string]$dns))) { Fail 'INVALID_CONFIG' 'Invalid DNS address' } }
    foreach($field in @('resolverDomain','internalHost')) { if ($c.$field -and !(Valid-Domain ([string]$c.$field))) { Fail 'INVALID_CONFIG' 'Invalid intranet domain' } }
    if ($c.internalProbeIP -and !(Valid-Ip ([string]$c.internalProbeIP))) { Fail 'INVALID_CONFIG' 'Invalid probe address' }
    if ([string]$Config.windows.adapterName -match '[\x00-\x1f]' -or ([string]$Config.windows.adapterName).Length -gt 120) { Fail 'INVALID_CONFIG' 'Invalid adapter name' }
    if(([string]$Config.vpn.configName).StartsWith('/')){Fail 'INVALID_CONFIG' 'VPN connection name cannot be a command option'}
    return $Config
}
function Pending-Snapshot([string]$File,$Snapshot) {
    if (Test-Path -LiteralPath $File) { $old=Read-Json $File; if ($old.pending) { return $old } }
    $Snapshot.pending=$true; Write-Json $File $Snapshot; return $Snapshot
}
function Assert-Adapter($Snapshot) {
    $adapter=Get-NetAdapter -InterfaceIndex ([int]$Snapshot.index)
    if ($adapter.InterfaceGuid.ToString() -ne $Snapshot.guid) { Fail 'ADAPTER_CHANGED' 'Original network adapter is unavailable' }
    return $adapter
}
function DNS-Snapshot($Identity) {
    $families=@{};$guid='{'+$Identity.guid.Trim('{','}')+'}'
    foreach($family in @('IPv4','IPv6')) {
        $proto=if($family -eq 'IPv4'){'Tcpip'}else{'Tcpip6'}
        $reg='HKLM:\SYSTEM\CurrentControlSet\Services\'+$proto+'\Parameters\Interfaces\'+$guid
        $manual=(Get-ItemProperty -LiteralPath $reg -Name NameServer -ErrorAction SilentlyContinue).NameServer
        $servers=@((Get-DnsClientServerAddress -InterfaceIndex $Identity.index -AddressFamily $family).ServerAddresses)
        $families[$family]=@{automatic=![bool]$manual;servers=$servers}
    }
    return @{index=$Identity.index;guid=$Identity.guid;families=$families}
}
function Restore-DNS($Snapshot) {
    $null=Assert-Adapter $Snapshot
    foreach($family in @('IPv4','IPv6')) {
        $entry=$Snapshot.families.$family;$target=Get-DnsClientServerAddress -InterfaceIndex ([int]$Snapshot.index) -AddressFamily $family
        if ($entry.automatic) { Set-DnsClientServerAddress -InputObject $target -ResetServerAddresses }
        else { $addresses=@($entry.servers);foreach($ip in $addresses){if(!(Valid-Ip $ip)){Fail 'BAD_BACKUP' 'Invalid DNS snapshot'}};Set-DnsClientServerAddress -InputObject $target -ServerAddresses $addresses }
    }
    Clear-DnsClientCache
}
function Apply-DNS($ActionArgs,[string]$GrantRoot) {
    if ($ActionArgs.primary -ne 'empty' -and !(Valid-Ip ([string]$ActionArgs.primary))) { Fail 'INVALID_DNS' 'Invalid primary DNS' }
    if ($ActionArgs.secondary -and !(Valid-Ip ([string]$ActionArgs.secondary))) { Fail 'INVALID_DNS' 'Invalid secondary DNS' }
    $id=Active-Identity;if (!$id.index) { Fail 'NO_INTERFACE' 'No physical network interface' }
    $file=Join-Path $GrantRoot 'dns-backup.json';$snapshot=Pending-Snapshot $file (DNS-Snapshot $id)
    if ($snapshot.guid -ne $id.guid) { Fail 'PENDING_RESTORE' 'Restore the previous network adapter first' }
    try {
        if ($ActionArgs.primary -eq 'empty') { Set-DnsClientServerAddress -InterfaceIndex $id.index -ResetServerAddresses }
        else {
            $addresses=@([string]$ActionArgs.primary);if($ActionArgs.secondary){$addresses+=[string]$ActionArgs.secondary}
            Set-DnsClientServerAddress -InterfaceIndex $id.index -ServerAddresses $addresses
            $resolved=@();foreach($server in $addresses) { try { $resolved+=@(Resolve-DnsName -Name 'www.baidu.com' -Server $server -Type A -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object IPAddress);if($resolved.Count){break} } catch {} }
            if (!$resolved.Count) { Fail 'DNS_VERIFY_FAILED' 'New DNS could not resolve a public domain' }
        }
        Clear-DnsClientCache
    } catch {
        $original=$_.Exception
        try { Restore-DNS $snapshot } catch { Fail 'ROLLBACK_FAILED' 'DNS change failed and restoring the original settings failed; please use the restore action' }
        Fail 'DNS_ROLLED_BACK' ('DNS change failed; original settings restored: '+$original.Message)
    }
    return @{ok=$true;message='DNS settings applied; original snapshot is available for restore'}
}
function Clear-StaleProxy([string]$Sid,[string]$GrantRoot) {
    $info=Proxy-Info $Sid;$bad=@($info.endpoints | Where-Object { $_.local -and !$_.reachable })
    if (!$bad.Count) { return @{ok=$true;message='No failed local proxy endpoint; settings preserved'} }
    $reg=Proxy-Path $Sid;$snapshot=Pending-Snapshot (Join-Path $GrantRoot 'proxy-backup.json') @{sid=$Sid;enable=1;server=$info.server}
    $badEntries=@($bad | ForEach-Object {$_.entry});$remaining=@($info.server.Split(';') | Where-Object {$_ -notin $badEntries})
    if ($remaining.Count) { Set-ItemProperty -LiteralPath $reg -Name ProxyServer -Value ($remaining -join ';') }
    else { Set-ItemProperty -LiteralPath $reg -Name ProxyEnable -Type DWord -Value 0 }
    return @{ok=$true;message='Failed local proxy entries temporarily disabled; working endpoints and PAC preserved'}
}
function Renew-DHCP {
    $id=Active-Identity;if (!$id.physical -or !$id.index) { Fail 'NO_PHYSICAL_INTERFACE' 'No physical interface for DHCP renewal' }
    $ipInterface=Get-NetIPInterface -InterfaceIndex $id.index -AddressFamily IPv4
    if ($ipInterface.Dhcp -ne 'Enabled') { Fail 'STATIC_IP' 'Static IP preserved; automatic DHCP repair refused' }
    $output=& (Join-Path $env:SystemRoot 'System32\ipconfig.exe') /renew $id.iface 2>&1
    if ($LASTEXITCODE -ne 0) { Fail 'DHCP_FAILED' 'DHCP renewal failed' }
    return @{ok=$true;message='DHCP lease renewed'}
}
function VPN-Status($Config) {
    $adapter=$null;if($Config.windows.adapterName){$adapter=Get-NetAdapter -ErrorAction SilentlyContinue|Where-Object {$_.Name -ceq [string]$Config.windows.adapterName}|Select-Object -First 1}
    $connected=$adapter -and $adapter.Status -eq 'Up';$rules=@()
    if($Config.company.resolverDomain){$rules=@(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Namespace -contains ('.'+$Config.company.resolverDomain) })}
    return @{configured=[bool]$Config.windows.adapterName;vpnConnected=[bool]$connected;resolverInstalled=($rules.Count -gt 0);detail=$(if($connected){'Configured VPN adapter is connected'}else{'Select the actual connected VPN adapter in configuration'})}
}
function VPN-Coexist($Config,[string]$Sid,[string]$GrantRoot) {
    $Config=Validate-Config $Config;$c=$Config.company
    if(!$Config.windows.adapterName -or !$c.intranetCIDR -or !$c.resolverDomain -or !@($c.intranetDNS).Count){Fail 'VPN_CONFIG_REQUIRED' 'VPN adapter, private route, domain and DNS are required'}
    $adapter=Get-NetAdapter | Where-Object {$_.Name -ceq [string]$Config.windows.adapterName} | Select-Object -First 1
    if($adapter.Status -ne 'Up' -or $adapter.HardwareInterface){Fail 'VPN_NOT_CONNECTED' 'Selected VPN adapter must be an active virtual adapter'}
    $file=Join-Path $GrantRoot 'vpn-backup.json'
    if(Test-Path -LiteralPath $file){$existing=Read-Json $file;if($existing.pending){Fail 'PENDING_RESTORE' 'Coexistence already applied; restore before changing its configuration'}}
    $conflict=@(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Namespace -contains ('.'+$c.resolverDomain) });if($conflict.Count){Fail 'NRPT_CONFLICT' 'Existing domain DNS policy preserved; ask the network administrator'}
    $originalProxy=Proxy-Info $Sid
    $broadPrefixes=@('0.0.0.0/0','0.0.0.0/1','128.0.0.0/1','::/0','::/1','8000::/1')
    $broad=@(Get-NetRoute -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in $broadPrefixes } | ForEach-Object {@{prefix=$_.DestinationPrefix;gateway=$_.NextHop;metric=[int]$_.RouteMetric;family=$(if($_.DestinationPrefix.Contains(':')){'IPv6'}else{'IPv4'})}})
    foreach($family in @($broad|ForEach-Object {$_.family}|Select-Object -Unique)){
        $default=if($family -eq 'IPv6'){'::/0'}else{'0.0.0.0/0'}
        $physical=@(Get-NetRoute -AddressFamily $family -DestinationPrefix $default -ErrorAction SilentlyContinue|Where-Object {$_.InterfaceIndex -ne $adapter.ifIndex -and (Ordinary-Adapter (Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue))})
        if(!$physical.Count){Fail 'NO_PUBLIC_DEFAULT' 'No verified non-VPN default route; original VPN routes preserved'}
    }
    $tag='LaoyuNetTools-'+[guid]::NewGuid().ToString()
    $bypass=@($originalProxy.override.Split(';') | Where-Object {$_});$bypass+='*.'+$c.resolverDomain;if($c.internalHost){$bypass+=[string]$c.internalHost}
    $snapshot=@{pending=$true;index=[int]$adapter.ifIndex;guid=$adapter.InterfaceGuid.ToString();domain=[string]$c.resolverDomain;originalOverride=$originalProxy.override;addedRoutes=@();removedRoutes=@();ruleName='';ruleTag=$tag;appliedOverride=(($bypass|Select-Object -Unique)-join ';')}
    Write-Json $file $snapshot
    try {
        $prefixes=@([string]$c.intranetCIDR)+@($c.intranetDNS | ForEach-Object {if($_.Contains(':')){$_+'/128'}else{$_+'/32'}})
        foreach($prefix in ($prefixes | Select-Object -Unique)) {
            $old=@(Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix $prefix -ErrorAction SilentlyContinue)
            if(!$old.Count){
                $family=if($prefix.Contains(':')){'IPv6'}else{'IPv4'}
                $gateway=if($family -eq 'IPv6'){'::'}else{'0.0.0.0'}
                $via=@($broad|Where-Object {$_.family -eq $family}|Select-Object -First 1);if($via.Count){$gateway=$via[0].gateway}
                # Durable write-ahead plan: a crash after New-NetRoute cannot
                # leave a route absent from the recovery snapshot.
                $snapshot.addedRoutes+=@{prefix=$prefix;gateway=$gateway};Write-Json $file $snapshot
                $null=New-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix $prefix -NextHop $gateway -PolicyStore ActiveStore
            }
        }
        foreach($route in $broad){$snapshot.removedRoutes+=$route;Write-Json $file $snapshot;Remove-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix $route.prefix -NextHop $route.gateway -Confirm:$false}
        # NRPT assigns its own opaque Name. Persist a unique tag before creating
        # the rule so reset can find it even if creation's reply was interrupted.
        Write-Json $file $snapshot
        $rule=Add-DnsClientNrptRule -Namespace ('.'+$c.resolverDomain) -NameServers @($c.intranetDNS) -DisplayName $tag -Comment ('LaoyuNetTools '+$Sid+' '+$tag) -PassThru
        $snapshot.ruleName=[string]$rule.Name;Write-Json $file $snapshot
        Set-ItemProperty -LiteralPath (Proxy-Path $Sid) -Name ProxyOverride -Value $snapshot.appliedOverride;Write-Json $file $snapshot;Clear-DnsClientCache
        $verified=VPN-Status $Config;if(!$verified.vpnConnected -or !$verified.resolverInstalled){Fail 'VPN_VERIFY_FAILED' 'VPN route or domain DNS validation failed'}
        Start-Sleep -Milliseconds 700
        if(@(Get-NetRoute -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue|Where-Object {$_.DestinationPrefix -in $broadPrefixes}).Count){Fail 'VPN_VERIFY_FAILED' 'VPN client reintroduced a broad public route'}
        foreach($family in @($broad|ForEach-Object {$_.family}|Select-Object -Unique)){
            $probe=if($family -eq 'IPv6'){'2606:4700:4700::1111'}else{'223.5.5.5'}
            $best=@(Find-NetRoute -RemoteIPAddress $probe|Where-Object {$_.PSObject.Properties['DestinationPrefix']})
            if(!$best.Count -or $best[0].InterfaceIndex -eq $adapter.ifIndex){Fail 'VPN_VERIFY_FAILED' 'Public traffic still selects the VPN interface'}
        }
    } catch { Fail 'VPN_PARTIAL' 'Coexistence did not fully apply; use restore to recover the saved original configuration' }
    return @{ok=$true;allOk=$true;message='VPN private routes and domain DNS applied; public traffic stays outside the VPN half-routes'}
}
function Reset-VPN([string]$Sid,[string]$GrantRoot) {
    $file=Join-Path $GrantRoot 'vpn-backup.json';$snapshot=Read-Json $file;if(!$snapshot.pending){Fail 'NO_BACKUP' 'No pending coexistence configuration'};$null=Assert-Adapter $snapshot
    $rules=@()
    if($snapshot.ruleName){$rules=@(Get-DnsClientNrptRule -Name $snapshot.ruleName -ErrorAction SilentlyContinue)}
    if(!$rules.Count -and $snapshot.ruleTag){$rules=@(Get-DnsClientNrptRule -ErrorAction SilentlyContinue|Where-Object {$_.DisplayName -eq $snapshot.ruleTag})}
    foreach($rule in $rules){if($rule.Comment -ne ('LaoyuNetTools '+$Sid+' '+$snapshot.ruleTag) -or $rule.Namespace -notcontains ('.'+$snapshot.domain)){Fail 'POLICY_CHANGED' 'Domain policy belongs to another administrator'};Remove-DnsClientNrptRule -Name $rule.Name -Force}
    foreach($route in @($snapshot.addedRoutes)){ $found=@(Get-NetRoute -InterfaceIndex $snapshot.index -DestinationPrefix $route.prefix -NextHop $route.gateway -ErrorAction SilentlyContinue);foreach($entry in $found){Remove-NetRoute -InputObject $entry -Confirm:$false} }
    foreach($route in @($snapshot.removedRoutes)){if(!@(Get-NetRoute -InterfaceIndex $snapshot.index -DestinationPrefix $route.prefix -NextHop $route.gateway -ErrorAction SilentlyContinue).Count){$null=New-NetRoute -InterfaceIndex $snapshot.index -DestinationPrefix $route.prefix -NextHop $route.gateway -RouteMetric $route.metric -PolicyStore ActiveStore}}
    $current=Proxy-Info $Sid;if($current.override -ne $snapshot.appliedOverride -and $current.override -ne $snapshot.originalOverride){Fail 'PROXY_CHANGED' 'Proxy bypass was edited after coexistence; original snapshot preserved'}
    Set-ItemProperty -LiteralPath (Proxy-Path $Sid) -Name ProxyOverride -Value ([string]$snapshot.originalOverride)
    Clear-DnsClientCache;$snapshot.pending=$false;Write-Json $file $snapshot
    return @{ok=$true;message='Original VPN route and proxy bypass settings restored'}
}
function Invoke-Privileged([string]$Action,$ActionArgs,[string]$Sid,[string]$GrantRoot) {
    switch($Action) {
        'flush-dns' { Clear-DnsClientCache;return @{ok=$true;message='DNS cache refreshed'} }
        'set-dns' { return Apply-DNS $ActionArgs $GrantRoot }
        'restore-dns' { $file=Join-Path $GrantRoot 'dns-backup.json';$snapshot=Read-Json $file;if(!$snapshot.pending){Fail 'NO_BACKUP' 'No pending DNS snapshot'};Restore-DNS $snapshot;$snapshot.pending=$false;Write-Json $file $snapshot;return @{ok=$true;message='Original DNS settings restored'} }
        'clear-proxy' { return Clear-StaleProxy $Sid $GrantRoot }
        'restore-proxy' { $file=Join-Path $GrantRoot 'proxy-backup.json';$snapshot=Read-Json $file;if(!$snapshot.pending -or $snapshot.sid -ne $Sid){Fail 'NO_BACKUP' 'No pending proxy snapshot'};$reg=Proxy-Path $Sid;Set-ItemProperty -LiteralPath $reg -Name ProxyServer -Value ([string]$snapshot.server);Set-ItemProperty -LiteralPath $reg -Name ProxyEnable -Type DWord -Value ([int]$snapshot.enable);$snapshot.pending=$false;Write-Json $file $snapshot;return @{ok=$true;message='Original proxy state restored'} }
        'renew-dhcp' { return Renew-DHCP }
        'vpn-coexist' { return VPN-Coexist $ActionArgs.config $Sid $GrantRoot }
        'vpn-coexist-reset' { return Reset-VPN $Sid $GrantRoot }
        default { Fail 'INVALID_ACTION' 'Unknown privileged action' }
    }
}
# Private read-only cleanup query; never dispatched through the public JS API.
function Authorization-ProcessStatus($Identity) {
    $keys=@('nonce','mode','CallerSid','pid','createdTicks')
    $given=if($Identity -is [Collections.IDictionary]){@($Identity.Keys)}else{@($Identity.PSObject.Properties.Name)}
    if($given.Count -ne $keys.Count -or @($given|Where-Object {$_ -notin $keys}).Count -or
       $Identity.nonce -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
       $Identity.mode -notin @('install','uninstall') -or $Identity.CallerSid -cne (Caller-Sid) -or
       ($Identity.pid -isnot [int] -and $Identity.pid -isnot [long]) -or $Identity.pid -lt 1 -or $Identity.pid -gt 2147483647 -or $Identity.createdTicks -isnot [string] -or $Identity.createdTicks -cnotmatch '^\d{18}$') {Fail 'INVALID_REQUEST' 'Invalid authorization process identity'}
    $instance=Read-AuthorizationProcess $Identity.pid
    $state=if(!$instance.exists){'exited'}elseif($instance.createdTicks -cne $Identity.createdTicks){'replaced'}else{'running'}
    return @{nonce=$Identity.nonce;mode=$Identity.mode;CallerSid=$Identity.CallerSid;pid=$Identity.pid;createdTicks=$Identity.createdTicks;state=$state}
}
function Read-AuthorizationProcess([int]$ProcessId) {
    # Only ArgumentException from GetProcessById means this PID is absent.
    # Access denied and all StartTime/handle query failures remain real failures.
    try{$instance=[Diagnostics.Process]::GetProcessById($ProcessId)}catch{
        $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
        if($cause -is [ArgumentException]){return @{exists=$false}}
        throw
    }
    try{
        if($instance.HasExited){return @{exists=$false}}
        return @{exists=$true;createdTicks=$instance.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}
    }finally{$instance.Dispose()}
}
function Invoke-Read([string]$Action,$ActionArgs,[string]$ConfigDirectory) {
    switch($Action) {
        'get-status' { $id=Active-Identity;return @{iface=$id.iface;service=$id.service;ip=$id.ip;gateway=$id.gateway;online=$null;linkAvailable=($id.ip -ne '');os=[Environment]::OSVersion.VersionString;dhcp=$id.dhcp} }
        'network-check' { return Network-Check }
        'diagnose' {
            $check=Network-Check
            $items=@(
                @{name='Physical network';status=$(if($check.ip){'ok'}else{'err'});detail=$check.interface},
                @{name='Default route';status=$(if($check.gateway){'ok'}else{'err'});detail=$check.gateway},
                @{name='Public connectivity';status=$(if($check.rawOk -or $check.httpOk){'ok'}else{'err'});detail=$check.issue},
                @{name='DNS';status=$(if($check.dnsOk){'ok'}else{'warn'});detail='System domain resolution'},
                @{name='HTTPS';status=$(if($check.httpOk){'ok'}else{'err'});detail='Verified HTTPS response'},
                @{name='Proxy';status=$(if($check.proxyReachable){'ok'}else{'err'});detail=$(if($check.proxyEnabled){'Enabled'}else{'Disabled'})}
            )
            $hosts=Get-Content -LiteralPath (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') | Where-Object {$_ -notmatch '^\s*(#|$)' -and $_ -notmatch '\blocalhost\b'}
            $firewall=@(Get-NetFirewallProfile)
            $items+=@{name='hosts';status=$(if(@($hosts).Count){'info'}else{'ok'});detail=([string]@($hosts).Count+' custom entries; not modified')}
            $items+=@{name='Firewall';status='info';detail=([string]@($firewall|Where-Object Enabled).Count+' profiles enabled; not modified')}
            return @{items=$items;issue=$check.issue}
        }
        'helper-status' { return Helper-Status }
        'authorization-process-status' { return Authorization-ProcessStatus $ActionArgs }
        'task-status' { if($ActionArgs.taskAction -notin $PrivilegedActions){Fail 'INVALID_ACTION' 'Invalid task query'};$sid=Caller-Sid;$task=Get-ScheduledTask -TaskPath ('\LaoyuNetTools\'+$sid+'\') -TaskName $ActionArgs.taskAction;return @{state=[string]$task.State} }
        'get-config' { return @{config=(Load-Config $ConfigDirectory)} }
        'export-config' { return @{json=((Load-Config $ConfigDirectory)|ConvertTo-Json -Depth 10);message='Configuration ready to copy'} }
        'save-config' { $config=Validate-Config $ActionArgs.config;$null=New-Item -ItemType Directory -Path $ConfigDirectory -Force;Write-Json (Join-Path $ConfigDirectory 'config.json') $config;return @{message='Configuration saved'} }
        'import-config' { if(([string]$ActionArgs.json).Length -gt 32768){Fail 'INVALID_CONFIG' 'Configuration is too large'};$config=Validate-Config ($ActionArgs.json|ConvertFrom-Json);$null=New-Item -ItemType Directory -Path $ConfigDirectory -Force;Write-Json (Join-Path $ConfigDirectory 'config.json') $config;return @{message='Configuration imported'} }
        'vpn-status' { return VPN-Status (Load-Config $ConfigDirectory) }
        'vpn-connect' {
            $cfg=Validate-Config (Load-Config $ConfigDirectory);$name=[string]$cfg.vpn.configName
            if(!$name){Fail 'VPN_CONFIG_REQUIRED' 'Select a Windows native VPN connection'}
            $connections=@(Get-VpnConnection -ErrorAction SilentlyContinue)+@(Get-VpnConnection -AllUserConnection -ErrorAction SilentlyContinue)
            $matching=@($connections|Where-Object {$_.Name -ceq $name})
            if($matching.Count -ne 1){Fail 'VPN_CONFIG_REQUIRED' 'Select exactly one existing Windows native VPN connection; connect third-party clients separately'}
            $output=& (Join-Path $env:SystemRoot 'System32\rasdial.exe') $name 2>&1
            if($LASTEXITCODE -ne 0){Fail 'VPN_CONNECT_FAILED' 'Windows native VPN connection failed'}
            return @{message='Windows native VPN connection requested'}
        }
        'wifi-info' { $raw=& (Join-Path $env:SystemRoot 'System32\netsh.exe') wlan show interfaces 2>&1;if($LASTEXITCODE -ne 0){Fail 'WIFI_UNAVAILABLE' 'WiFi information unavailable'};$ssid='';$signal=$null;$txrate=$null;$channel='';foreach($line in $raw){if($line -match '^\s*SSID\s*:\s*(.+)$'){$ssid=$Matches[1]};if($line -match '(Signal|信号)\s*:\s*(\d+)%'){$signal=[int]$Matches[2]};if($line -match '(Channel|频道|信道)\s*:\s*(\d+)'){$channel=$Matches[2]};if($line -match '(Transmit rate|传输速率).*:\s*([\d.]+)'){$txrate=[double]$Matches[2]}};return @{connected=[bool]$ssid;ssid=$ssid;signalPercent=$signal;channel=$channel;txrate=$txrate;noise=$null;snr=$null;detail='Windows does not expose noise/SNR through netsh'} }
        'ping-test' { $items=@();foreach($target in @('223.5.5.5','119.29.29.29','1.1.1.1')){$ping=New-Object Net.NetworkInformation.Ping;$reply=$null;try{$reply=$ping.Send($target,2000)}catch{}finally{$ping.Dispose()};$items+=@{target=$target;ok=($reply -and $reply.Status -eq 'Success');latencyMs=$(if($reply -and $reply.Status -eq 'Success'){$reply.RoundtripTime}else{$null})}};return @{items=$items} }
        'speedtest' { $url='https://speed.cloudflare.com/__down?bytes=10000000';$request=[Net.HttpWebRequest]::Create($url);$request.Timeout=20000;$request.ReadWriteTimeout=20000;$request.Proxy=[Net.WebRequest]::GetSystemWebProxy();$response=$null;$stream=$null;$timer=[Diagnostics.Stopwatch]::StartNew();$bytes=0;try{$response=$request.GetResponse();$stream=$response.GetResponseStream();$buffer=New-Object byte[] 65536;while(($n=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$bytes+=$n;if($bytes -gt 11000000){Fail 'SPEED_LIMIT' 'Unexpected download size'}}}finally{if($stream){$stream.Dispose()};if($response){$response.Close()};$request.Abort();$timer.Stop()};if($bytes -lt 1){Fail 'SPEED_FAILED' 'No download received'};return @{downloadMbps=[Math]::Round($bytes*8/$timer.Elapsed.TotalSeconds/1000000,2);bytes=$bytes;durationMs=$timer.ElapsedMilliseconds;source='Cloudflare'} }
        default { Fail 'INVALID_ACTION' 'Unknown action' }
    }
}
if($Library){return}
$nonce='';$resultFile=''
$workerMutex=$null;$workerLockHeld=$false
try {
    if($WorkerAction) {
        if($WorkerAction -notin $PrivilegedActions -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18'){Fail 'UNAUTHORIZED' 'Privileged worker requires a registered SYSTEM task'}
        $grantRoot=Grant-Root $GrantSid;Assert-ProtectedRoot $grantRoot;$grant=Read-Json (Join-Path $grantRoot 'grant.json')
        if($grant.sid -ne $GrantSid -or $grant.version -ne $NetToolsVersion){Fail 'AUTH_VERSION' 'Authorization grant version mismatch'}
        $hash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();if($hash -ne $grant.scriptSha256){Fail 'AUTH_HASH' 'Privileged worker has changed'}
        $request=Read-Json (Join-Path $grantRoot 'requests\request.json');$nonce=[string]$request.nonce
        if($request.action -ne $WorkerAction -or $nonce -notmatch '^[a-fA-F0-9-]{36}$'){Fail 'INVALID_REQUEST' 'Request does not match fixed task action'}
        $requested=[DateTime]::Parse([string]$request.requestedAt).ToUniversalTime()
        if([Math]::Abs(([DateTime]::UtcNow-$requested).TotalSeconds) -gt 60){Fail 'STALE_REQUEST' 'The repair request is no longer current'}
        $workerMutex=New-Object Threading.Mutex($false,('Local\LaoyuNetTools.'+$GrantSid))
        try{$workerLockHeld=$workerMutex.WaitOne(1000)}catch [Threading.AbandonedMutexException]{$workerLockHeld=$true}
        if(!$workerLockHeld){Fail 'BUSY' 'Another authorized worker is still active'}
        $resultFile=Join-Path $grantRoot ($WorkerAction+'.result.json')
        $actionArgs=$request.args
        $data=Invoke-Privileged $WorkerAction $actionArgs $GrantSid $grantRoot
    } else {
        $text=[Console]::In.ReadToEnd();if($text.Length -gt 65536){Fail 'INVALID_REQUEST' 'Request is too large'};$request=$text|ConvertFrom-Json
        if(!$request.configDir -or ![IO.Path]::IsPathRooted([string]$request.configDir)){Fail 'INVALID_CONFIG' 'Configuration path must be absolute'}
        $data=Invoke-Read ([string]$request.action) $request.args ([string]$request.configDir)
    }
    $result=@{ok=$true;data=$data;nonce=$nonce}
    if($resultFile){Write-Json $resultFile $result}else{[Console]::Out.WriteLine(($result|ConvertTo-Json -Depth 14 -Compress))}
    exit 0
} catch {
    $code=[string]$_.Exception.Data['code'];if(!$code){$code='SYSTEM_ERROR'}
    $result=@{ok=$false;error=@{code=$code;message=$_.Exception.Message};nonce=$nonce}
    if($resultFile){try{Write-Json $resultFile $result}catch{}}
    else{[Console]::Out.WriteLine(($result|ConvertTo-Json -Depth 8 -Compress))}
    exit 1
}finally{if($workerMutex){if($workerLockHeld){$workerMutex.ReleaseMutex()};$workerMutex.Dispose()}}
