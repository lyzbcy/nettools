param([ValidateSet('install','uninstall')][string]$Mode, [string]$CallerSid, [string]$Nonce, [switch]$Elevated, [switch]$Library)
if ($PSVersionTable.PSEdition -ne 'Core') { $env:PSModulePath = $PSHOME + '\Modules;' + [Environment]::GetEnvironmentVariable('PSModulePath','Machine') }
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$Version='5.0.0'
$Actions=@('flush-dns','set-dns','restore-dns','clear-proxy','restore-proxy','renew-dhcp','vpn-coexist','vpn-coexist-reset')

function Reject([string]$Code,[string]$Message){$e=New-Object Exception($Message);$e.Data['code']=$Code;throw $e}
function Check-Ordinary([string]$LiteralPath){if(Test-Path -LiteralPath $LiteralPath){$item=Get-Item -LiteralPath $LiteralPath -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Reject 'UNSAFE_PATH' 'Authorization paths cannot be symbolic links or junctions'}}}
function File-Hash([string]$LiteralPath){Check-Ordinary $LiteralPath;$sha=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($LiteralPath);try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}}
function Write-Result([string]$LiteralPath,$Value){Check-Ordinary $LiteralPath;$tmp=$LiteralPath+'.'+[guid]::NewGuid().ToString()+'.tmp';try{[IO.File]::WriteAllText($tmp,($Value|ConvertTo-Json -Compress -Depth 8),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $tmp -Destination $LiteralPath -Force}finally{if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force}}}
function Protect-Directory([string]$LiteralPath,[string]$Sddl){
    Check-Ordinary $LiteralPath
    if(Test-Path -LiteralPath $LiteralPath){$acl=Get-Acl -LiteralPath $LiteralPath;$owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value;if($owner -notin @('S-1-5-18','S-1-5-32-544')){Reject 'UNSAFE_OWNER' 'An existing authorization folder is not administrator-owned'}}
    else{$null=[IO.Directory]::CreateDirectory($LiteralPath)}
    $security=New-Object Security.AccessControl.DirectorySecurity
    $security.SetSecurityDescriptorSddlForm($Sddl)
    $security.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    Set-Acl -LiteralPath $LiteralPath -AclObject $security
}
function Authorization-Completion {
    $value=@{nonce=$Nonce;mode=$Mode;CallerSid=$CallerSid;execution=$script:authorizationExecution;closed=$script:authorizationClosed}
    if($script:authorizationChildIdentity){$value.pid=$script:authorizationChildIdentity.pid;$value.createdTicks=$script:authorizationChildIdentity.createdTicks}
    return $value
}
function Wait-AuthorizationChild([string]$PowerShell,[string]$Arguments) {
    $script:authorizationExecution='unknown';$script:authorizationClosed=$false
    try{$child=Start-Process -FilePath $PowerShell -ArgumentList $Arguments -Verb RunAs -WindowStyle Hidden -PassThru}
    catch{
        $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
        if($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223){$script:authorizationExecution='none';$script:authorizationClosed=$true;Reject 'AUTH_CANCELLED' 'Authorization was declined'}
        throw
    }
    $script:authorizationExecution='child'
    $script:authorizationChildIdentity=@{type='nettools-auth-child';nonce=$Nonce;mode=$Mode;CallerSid=$CallerSid;pid=$child.Id;createdTicks=$child.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}
    [Console]::Error.WriteLine(($script:authorizationChildIdentity|ConvertTo-Json -Compress));[Console]::Error.Flush()
    # Wait on the returned handle; a PID lookup can refer to a later process.
    $child.WaitForExit();$child.Refresh();$script:authorizationClosed=$true
    return $child
}
if($Library){return}
$script:authorizationExecution='none';$script:authorizationClosed=$true;$script:authorizationChildIdentity=$null
$resultFile='';$stageName='validate'
try{
    if($Nonce -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){Reject 'INVALID_NONCE' 'Invalid authorization attempt'}
    if($CallerSid -notmatch '^S-1-5-21-(\d+-){2,}\d+$'){Reject 'INVALID_SID' 'Invalid authorizing user'}
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $base=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'LaoyuNetTools'
    $grants=Join-Path $base 'Grants';$grantRoot=Join-Path $grants $CallerSid;$resultFile=Join-Path $grantRoot 'authorization-result.json'
    if(!$isAdmin){
        if($Elevated -or $identity.User.Value -ne $CallerSid){Reject 'UNAUTHORIZED' 'Authorization must be initiated by the installing user'}
        $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Mode '+$Mode+' -CallerSid '+$CallerSid+' -Nonce '+$Nonce+' -Elevated'
        $child=Wait-AuthorizationChild $ps $arguments
        if($child.ExitCode -ne 0){Reject 'AUTH_FAILED' 'Authorization was cancelled or failed'}
        Check-Ordinary $resultFile
        $result=[IO.File]::ReadAllText($resultFile,[Text.Encoding]::UTF8)|ConvertFrom-Json
        if($result.authorization.nonce -cne $Nonce -or $result.authorization.mode -cne $Mode -or $result.authorization.CallerSid -cne $CallerSid -or $result.authorization.closed -ne $true){Reject 'AUTH_FAILED' 'Authorization result did not match this operation'}
        $result.authorization=Authorization-Completion
        [Console]::Out.WriteLine(($result|ConvertTo-Json -Compress -Depth 8));exit 0
    }
    $script:authorizationExecution='direct';$script:authorizationClosed=$true
    $publicAcl='O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)'
    $stageName='protect-folders';Protect-Directory $base $publicAcl;Protect-Directory $grants $publicAcl
    $privateAcl='O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;'+$CallerSid+')'
    Protect-Directory $grantRoot $privateAcl
    $taskPath='\LaoyuNetTools\'+$CallerSid+'\'
    if($Mode -eq 'install'){
        $requests=Join-Path $grantRoot 'requests'
        # Only the bounded JSON request directory is writable by the installing
        # user. Worker scripts, snapshots, grants and results stay root-owned.
        $requestAcl='O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;'+$CallerSid+')'
        Protect-Directory $requests $requestAcl
        $source=Join-Path $PSScriptRoot 'windows-network.ps1';Check-Ordinary $source
        $sha=File-Hash $source;$destination=Join-Path $grantRoot 'windows-network.ps1';Check-Ordinary $destination
        $stage=Join-Path $grantRoot ('worker-'+[guid]::NewGuid().ToString()+'.tmp')
        try{[IO.File]::Copy($source,$stage,$false);if((File-Hash $stage) -ne $sha){Reject 'AUTH_HASH' 'Worker integrity changed during installation'};Move-Item -LiteralPath $stage -Destination $destination -Force}finally{if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Force}}
        $manifest=@{sid=$CallerSid;version=$Version;scriptSha256=$sha;installedAt=[DateTime]::UtcNow.ToString('o')}
        Write-Result (Join-Path $grantRoot 'grant.json') $manifest
        $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $schedule=New-Object -ComObject 'Schedule.Service';$schedule.Connect()
        foreach($name in $Actions){
            $stageName='register-'+$name
            $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$destination+'" -WorkerAction '+$name+' -GrantSid '+$CallerSid
            $action=New-ScheduledTaskAction -Execute $ps -Argument $arguments -WorkingDirectory $grantRoot
            $user=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 45) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            $null=Register-ScheduledTask -TaskPath $taskPath -TaskName $name -Action $action -Principal $user -Settings $settings -Force
            $stageName='task-permissions-'+$name
            $task=$schedule.GetFolder($taskPath.TrimEnd('\')).GetTask($name)
            $task.SetSecurityDescriptor(('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;'+$CallerSid+')'),0)
        }
        $result=@{ok=$true;data=@{mode=$Mode;installed=$true;version=$Version;message='Unattended repair authorization installed'}}
    }else{
        foreach($name in $Actions){
            $task=Get-ScheduledTask -TaskPath $taskPath -TaskName $name -ErrorAction SilentlyContinue
            if($task){Stop-ScheduledTask -InputObject $task;$until=[DateTime]::UtcNow.AddSeconds(60);do{Start-Sleep -Milliseconds 200;$state=(Get-ScheduledTask -TaskPath $taskPath -TaskName $name).State;if([DateTime]::UtcNow -gt $until){Reject 'TASK_STILL_RUNNING' 'Repair worker exit could not be confirmed; authorization retained'}}while($state -eq 'Running');Unregister-ScheduledTask -TaskPath $taskPath -TaskName $name -Confirm:$false}
        }
        foreach($name in @('grant.json','windows-network.ps1')){$file=Join-Path $grantRoot $name;Check-Ordinary $file;if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}}
        # Recovery snapshots remain protected for a later explicit reinstall.
        $result=@{ok=$true;data=@{mode=$Mode;installed=$false;version=$Version;message='Authorization removed; recovery snapshots preserved'}}
    }
    $result.authorization=Authorization-Completion
    Write-Result $resultFile $result
    [Console]::Out.WriteLine(($result|ConvertTo-Json -Compress -Depth 8));exit 0
}catch{
    $code=[string]$_.Exception.Data['code'];if(!$code){$code='AUTH_FAILED'}
    $result=@{ok=$false;error=@{code=$code;message=($stageName+': '+$_.Exception.Message)};authorization=(Authorization-Completion)}
    if($Elevated -and $resultFile -and (Test-Path -LiteralPath (Split-Path $resultFile -Parent))){try{Write-Result $resultFile $result}catch{}}
    [Console]::Out.WriteLine(($result|ConvertTo-Json -Compress -Depth 8));exit 1
}
