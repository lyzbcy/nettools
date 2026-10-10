$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../src/platform/windows-network.ps1') -Library
. (Join-Path $PSScriptRoot '../src/platform/windows-authorization.ps1') -Library
$passed=0
function Check([bool]$Condition,[string]$Message){if(!$Condition){throw ('FAILED: '+$Message)};$script:passed++}
$script:Nonce='12345678-1234-1234-1234-123456789abc';$script:Mode='install';$script:CallerSid='S-1-5-21-1-2-3-1001'
function Caller-Sid{return $script:CallerSid}
$current=Read-AuthorizationProcess $PID
Check ($current.exists -eq $true -and $current.createdTicks -match '^\d{18}$') 'current ordinary process has read-only exact identity'
Check (!(Read-AuthorizationProcess 2147483647).exists) 'only absent PID means exited'
$identity=@{nonce=$Nonce;mode=$Mode;CallerSid=$CallerSid;pid=$PID;createdTicks=$current.createdTicks}
Check ((Invoke-Read 'authorization-process-status' $identity '').state -eq 'running') 'private query sees current instance running'
$identity.pid=[long]$PID
Check ((Authorization-ProcessStatus $identity).state -eq 'running') 'JSON Int64 PID accepted within Int32 bounds'
$identity.createdTicks='638900000000000000'
Check ((Authorization-ProcessStatus $identity).state -eq 'replaced') 'PID reuse means original instance exited'
$identity.pid=2147483647
Check ((Authorization-ProcessStatus $identity).state -eq 'exited') 'query confirms absent PID'
$identity.CallerSid='S-1-5-21-9-9-9-1001'
try{Authorization-ProcessStatus $identity;throw 'should reject mismatched SID'}catch{Check ($_.Exception.Data['code'] -eq 'INVALID_REQUEST') 'query binds ordinary caller SID'}
$identity.CallerSid=$CallerSid;$identity.pid='1234'
try{Authorization-ProcessStatus $identity;throw 'should reject text PID'}catch{Check ($_.Exception.Data['code'] -eq 'INVALID_REQUEST') 'query rejects string PID'}
$identity.pid=1234
function Read-AuthorizationProcess {throw (New-Object UnauthorizedAccessException 'fixture query denied')}
try{Authorization-ProcessStatus $identity;throw 'should propagate query denied'}catch{Check ($_.Exception.Message -match 'fixture query denied') 'query denial cannot masquerade as exit'}

$script:waited=$false;$script:refreshed=$false;$script:launchWait=$false
function Start-Process {param($FilePath,$ArgumentList,$Verb,$WindowStyle,[switch]$PassThru,[switch]$Wait)
 Check ($Verb -eq 'RunAs' -and $PassThru -and !$Wait) 'launch returns handle without Start-Process Wait'
 $fake=[pscustomobject]@{Id=1234;StartTime=[DateTime]::SpecifyKind((New-Object DateTime 638900000000000000),[DateTimeKind]::Utc);ExitCode=0}
 $fake|Add-Member ScriptMethod WaitForExit {$script:waited=$true}
 $fake|Add-Member ScriptMethod Refresh {$script:refreshed=$true}
 return $fake
}
$script:authorizationChildIdentity=$null
$child=Wait-AuthorizationChild 'fixture-powershell' 'fixture-arguments'
Check ($waited -and $refreshed) 'waits and refreshes original returned handle'
$completion=Authorization-Completion
Check ($completion.execution -eq 'child' -and $completion.closed -eq $true -and $completion.pid -eq 1234 -and $completion.createdTicks -eq '638900000000000000') 'completion binds returned child identity'
function Start-Process {throw (New-Object ComponentModel.Win32Exception 1223)}
$script:authorizationChildIdentity=$null
try{Wait-AuthorizationChild 'fixture' 'args';throw 'must cancel'}catch{Check ($_.Exception.Data['code'] -eq 'AUTH_CANCELLED') 'UAC refusal has explicit cancelled classification'}
$completion=Authorization-Completion
Check ($completion.execution -eq 'none' -and $completion.closed -eq $true) 'cancelled before launch releases lease'
function Start-Process {throw 'fixture uncertain launch failure'}
try{Wait-AuthorizationChild 'fixture' 'args';throw 'must fail'}catch{Check ($_.Exception.Message -match 'fixture uncertain launch failure') 'unclassified launch error propagates'}
$completion=Authorization-Completion
Check ($completion.execution -eq 'unknown' -and $completion.closed -eq $false) 'uncertain launch failure cannot prove closure'
[Console]::Out.WriteLine((@{passed=$passed;failed=0;scope='Production authorization/query functions with fake process handles; no UAC or network writes'}|ConvertTo-Json -Compress))
