param([Parameter(Mandatory=$true)][string]$PayloadFile)
$ErrorActionPreference='Stop'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+[Environment]::GetEnvironmentVariable('PSModulePath','Machine')
$p=$null; $moved=$false; $installed=$false; $newProcess=$null
$utf8=New-Object Text.UTF8Encoding $false
function Read-Json([string]$file) { return ([IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) | ConvertFrom-Json) }
function Write-State([string]$file,$value) { $tmp=$file+'.'+[Guid]::NewGuid().ToString()+'.tmp';[IO.File]::WriteAllText($tmp,($value|ConvertTo-Json -Depth 10 -Compress),$utf8);Move-Item -LiteralPath $tmp -Destination $file -Force }
function No-Reparse([string]$file) { $item=Get-Item -LiteralPath $file -Force;if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw '更新路径包含重解析链接'};return $item }
function Sha([string]$file) { $stream=[IO.File]::OpenRead($file);$h=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($h.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$h.Dispose()} }
function Is-Aborted { if (!(Test-Path -LiteralPath $p.abortFile)) {return $false};try{return (Read-Json $p.abortFile).token -eq $p.token}catch{return $true} }
function Check-Identity([string]$root,[string]$version) { $null=No-Reparse $root;$pkg=Read-Json (Join-Path $root 'resources\app\package.json');if($pkg.name -ne 'laoyu-nettools' -or $pkg.main -ne 'src/main.cjs' -or $pkg.version -ne $version){throw '软件身份或版本不匹配'};$exe=Join-Path $root 'LaoyuNetTools.exe';$null=No-Reparse $exe;$s=[IO.File]::OpenRead($exe);$r=New-Object IO.BinaryReader $s;try{if($r.ReadUInt16() -ne 0x5a4d){throw 'Windows 主程序不是 PE'};$s.Position=60;$offset=$r.ReadUInt32();if($offset -gt $s.Length-24){throw 'PE 头无效'};$s.Position=$offset;if($r.ReadUInt32() -ne 0x4550 -or $r.ReadUInt16() -ne 0x8664){throw 'Windows 架构不匹配'}}finally{$r.Dispose();$s.Dispose()} }
function Check-Tree([string]$root) { $items=@(Get-ChildItem -LiteralPath $root -Recurse -Force);if($items.Count -ne $p.manifest.Count){throw '暂存应用数量改变'};foreach($e in $p.manifest){if(Is-Aborted){throw '更新已取消'};$file=Join-Path $root $e.path;$item=No-Reparse $file;if($e.kind -eq 'link'){throw 'Windows 更新不接受链接'};if($e.kind -eq 'dir'){if(!$item.PSIsContainer){throw '目录类型改变'}}elseif($item.PSIsContainer -or $item.Length -ne $e.size -or (Sha $file) -ne $e.sha256){throw '暂存应用大小或 SHA-256 改变'}} }
function Wait-Old { $old=Get-Process -Id $p.oldPid -ErrorAction SilentlyContinue;if($old -and !$old.WaitForExit([int]$p.oldExitTimeoutMs)){throw '旧版未退出，未替换应用'};if(Is-Aborted){throw '更新已取消'} }
function Launch-App([bool]$confirm) { $exe=Join-Path $p.target 'LaoyuNetTools.exe';$flag=if($confirm){'--nettools-update-confirm='+$p.confirmRequestFile}else{'--nettools-update-result='+$p.resultFile};# Quotes are Windows argv quoting, not executable shell text.
 $quoted='"'+$flag.Replace('"','\"')+'" "--nettools-data='+$p.dataDir.Replace('"','\"')+'"';return Start-Process -FilePath $exe -ArgumentList $quoted -WindowStyle Normal -PassThru }
try {
 $p=Read-Json $PayloadFile
 if($p.protocol -ne 1 -or $p.platform -ne 'win32' -or $p.token -notmatch '^[a-f0-9]{64}$' -or $p.oldPid -lt 1){throw '更新交接参数无效'}
 foreach($file in @($p.attempt,$p.stage,$p.target)){ $null=No-Reparse $file }
 if((Test-Path -LiteralPath $p.backup) -or (Test-Path -LiteralPath $p.incoming) -or (Is-Aborted)){throw '更新暂存项已存在或操作已取消'}
 if((Sha $p.archive) -ne $p.sha256 -or (Get-Item -LiteralPath $p.archive).Length -ne $p.size){throw '原始更新包 SHA-256 或大小改变'}
 Check-Identity $p.target $p.oldVersion;Check-Identity $p.stage $p.version;Check-Tree $p.stage
 Copy-Item -LiteralPath $p.stage -Destination $p.incoming -Recurse
 Check-Identity $p.incoming $p.version;Check-Tree $p.incoming
 # Preserve only uninstallers referenced by this product's exact per-user
 # registration. Portable copies do not create or inherit uninstall metadata.
 $registrations=@();$base='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
 if(Test-Path $base){foreach($key in Get-ChildItem $base){$value=Get-ItemProperty $key.PSPath;if($value.InstallLocation -and [IO.Path]::GetFullPath($value.InstallLocation).TrimEnd('\') -eq $p.target.TrimEnd('\') -and $value.DisplayName -eq '捞鱼的网络工具'){
  $registrations+=@{key=$key.PSPath;version=$value.DisplayVersion}
  $match=[regex]::Match([string]$value.UninstallString,'^(?:"(?<exe>[^"]+\.exe)"|(?<exe>.+?\.exe))(?:\s|$)')
  if($match.Success){$exe=[IO.Path]::GetFullPath($match.Groups['exe'].Value);if([IO.Path]::GetDirectoryName($exe).TrimEnd('\') -ne $p.target.TrimEnd('\')){throw '卸载器登记不在当前安装目录'};$item=No-Reparse $exe;if($item.PSIsContainer){throw '卸载器不是文件'};$destination=Join-Path $p.incoming $item.Name
   if(!(Test-Path -LiteralPath $destination)){Copy-Item -LiteralPath $exe -Destination $destination;$p.manifest+=([pscustomobject]@{path=$item.Name;kind='file';size=$item.Length;sha256=(Sha $exe)})}
  }else{throw '现有卸载器登记格式无效'}
 }}}
 Check-Tree $p.incoming
 Write-State $p.readyFile @{status='ready';token=$p.token;version=$p.version;pid=$PID}
 $deadline=[DateTime]::UtcNow.AddSeconds(30)
 while(!(Test-Path -LiteralPath $p.commitFile)){if((Is-Aborted) -or [DateTime]::UtcNow -gt $deadline){throw '更新交接未提交'};Start-Sleep -Milliseconds 50}
 if((Read-Json $p.commitFile).token -ne $p.token -or (Is-Aborted)){throw '更新交接已撤销'}
 Wait-Old
 Check-Identity $p.target $p.oldVersion;Check-Identity $p.incoming $p.version;Check-Tree $p.incoming
 Move-Item -LiteralPath $p.target -Destination $p.backup;$moved=$true
 Move-Item -LiteralPath $p.incoming -Destination $p.target;$installed=$true
 Check-Identity $p.target $p.version;$newProcess=Launch-App $true
 Write-State $p.resultFile @{status='installed';token=$p.token;version=$p.version;newPid=$newProcess.Id}
 $deadline=[DateTime]::UtcNow.AddMilliseconds($p.confirmationTimeoutMs);$confirmed=$false
 while([DateTime]::UtcNow -lt $deadline){if(Is-Aborted){throw '更新已取消'};if(Test-Path -LiteralPath $p.confirmFile){$c=Read-Json $p.confirmFile;if($c.token -eq $p.token -and $c.version -eq $p.version -and $c.appPath -eq $p.target -and $c.visible -eq $true -and $c.pid -eq $newProcess.Id -and !$newProcess.HasExited){$confirmed=$true;break}};if($newProcess.HasExited){throw '新版启动后退出，准备恢复旧版'};Start-Sleep -Milliseconds 100}
 if(!$confirmed){throw '新版未确认可见启动，准备恢复旧版'}
 foreach($registration in $registrations){Set-ItemProperty -LiteralPath $registration.key -Name DisplayVersion -Value $p.version}
 Write-State $p.resultFile @{status='confirmed';token=$p.token;version=$p.version;newPid=$newProcess.Id}
 try{Remove-Item -LiteralPath $p.backup -Recurse -Force}catch{Write-State $p.resultFile @{status='confirmed';token=$p.token;version=$p.version;newPid=$newProcess.Id;backupRetained=$true;backup=$p.backup;cleanupError=$_.Exception.Message}}
} catch {
 $message=$_.Exception.Message;$rollbackError=$null
 if($p){try{if($newProcess -and !$newProcess.HasExited){& (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $newProcess.Id /T /F | Out-Null;if(!$newProcess.WaitForExit(5000)){throw '新版进程仍未退出，未删除任何应用'}};if($moved){if($installed -and (Test-Path -LiteralPath $p.target)){Remove-Item -LiteralPath $p.target -Recurse -Force};if(Test-Path -LiteralPath $p.backup){Move-Item -LiteralPath $p.backup -Destination $p.target}};if(Test-Path -LiteralPath $p.incoming){Remove-Item -LiteralPath $p.incoming -Recurse -Force}}catch{$rollbackError=$_.Exception.Message}
  if($moved -and !$rollbackError){foreach($registration in $registrations){try{Set-ItemProperty -LiteralPath $registration.key -Name DisplayVersion -Value $registration.version}catch{$rollbackError=$_.Exception.Message}}}
  Write-State $p.resultFile @{status='failed';token=$p.token;version=$p.version;message=$message;rolledBack=($moved -and !$rollbackError);rollbackError=$rollbackError;backup=$p.backup}
  if($moved -and !$rollbackError){try{$reopened=Launch-App $false;Write-State $p.resultFile @{status='failed';token=$p.token;version=$p.version;message=$message;rolledBack=$true;reopened=$true;reopenPid=$reopened.Id;backup=$p.backup}}catch{Write-State $p.resultFile @{status='failed';token=$p.token;version=$p.version;message=$message;rolledBack=$true;reopenError=$_.Exception.Message;backup=$p.backup}}}
 }
 exit 1
}
