$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true'){throw 'ISOLATED_CI_ONLY'}
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+[Environment]::GetEnvironmentVariable('PSModulePath','Machine')
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($sid -notmatch '^S-1-5-21-(\d+-){2,}\d+$'){throw 'INVALID_SID'}
$root=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('LaoyuNetTools\Grants\'+$sid)
$report=@{capturedAt=[DateTime]::UtcNow.ToString('o');sid=$sid;action='flush-dns';files=@();task=$null}
foreach($relative in @('grant.json','requests\request.json','flush-dns.result.json','windows-network.ps1')){
 $file=Join-Path $root $relative
 try{
  $cursor=$file
  while($cursor){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'UNSAFE_LINK'};$parent=Split-Path -Parent $cursor;if($parent -eq $cursor){break};$cursor=$parent}
  $item=Get-Item -LiteralPath $file -Force;if($item.PSIsContainer){throw 'NOT_FILE'}
  $row=@{relative=$relative;exists=$true;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
  if($relative -ne 'windows-network.ps1'){
   if($item.Length -gt 65536){$row.readError='OVERSIZE'}else{$text=[IO.File]::ReadAllText($file,[Text.Encoding]::UTF8);$row.raw=$text;try{$value=$text|ConvertFrom-Json;$row.nonce=$value.nonce;$row.ok=$value.ok}catch{$row.parseError=$_.Exception.Message}}
  }
  $report.files+= $row
 }catch{$report.files+=@{relative=$relative;readError=$_.Exception.Message}}
}
try{
 $task=Get-ScheduledTask -TaskPath ('\LaoyuNetTools\'+$sid+'\') -TaskName 'flush-dns'
 $info=$task|Get-ScheduledTaskInfo
 $report.task=@{state=[string]$task.State;lastRunTime=$info.LastRunTime.ToUniversalTime().ToString('o');lastTaskResult=$info.LastTaskResult;principal=@{userId=$task.Principal.UserId;logonType=[string]$task.Principal.LogonType;runLevel=[string]$task.Principal.RunLevel};actions=@($task.Actions|ForEach-Object{@{execute=$_.Execute;arguments=$_.Arguments;workingDirectory=$_.WorkingDirectory}})}
}catch{$report.taskError=$_.Exception.Message}
[Console]::Out.WriteLine(($report|ConvertTo-Json -Depth 8 -Compress))
