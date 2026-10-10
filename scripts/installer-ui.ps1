param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$Version,[long]$PayloadBytes=1,[string]$Logo)
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -ne 'Core') { $env:PSModulePath=$PSHOME+'\Modules;'+[Environment]::GetEnvironmentVariable('PSModulePath','Machine') }
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Width="760" Height="560" WindowStartupLocation="CenterScreen" WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="True" Background="Transparent" FontFamily="Microsoft YaHei" Foreground="#294c39">
<Window.Resources>
<Style TargetType="Button"><Setter Property="Foreground" Value="#294c39"/><Setter Property="Background" Value="#e4ecdc"/><Setter Property="Margin" Value="4"/><Setter Property="Padding" Value="15,10"/><Setter Property="Cursor" Value="Hand"/><Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button"><Border Background="{TemplateBinding Background}" CornerRadius="11" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter Property="Opacity" Value="0.8"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.45"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
<Style TargetType="TextBox"><Setter Property="Padding" Value="14,12"/><Setter Property="Background" Value="#fffdf7"/><Setter Property="BorderBrush" Value="#b9c8b2"/><Setter Property="Template"><Setter.Value><ControlTemplate TargetType="TextBox"><Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" CornerRadius="11" Padding="{TemplateBinding Padding}"><ScrollViewer x:Name="PART_ContentHost"/></Border></ControlTemplate></Setter.Value></Setter></Style>
<Style TargetType="CheckBox"><Setter Property="Margin" Value="5,12"/><Setter Property="Template"><Setter.Value><ControlTemplate TargetType="CheckBox"><StackPanel Orientation="Horizontal"><Border Width="22" Height="22" Background="#e4ecdc" CornerRadius="6" Margin="0,0,10,0"><TextBlock x:Name="Tick" Text="✓" HorizontalAlignment="Center" VerticalAlignment="Center" Visibility="Collapsed" FontWeight="Bold"/></Border><ContentPresenter VerticalAlignment="Center"/></StackPanel><ControlTemplate.Triggers><Trigger Property="IsChecked" Value="True"><Setter TargetName="Tick" Property="Visibility" Value="Visible"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
</Window.Resources>
<Border CornerRadius="24" Background="#f8f5ec" BorderBrush="#758e73" BorderThickness="1"><Grid><Grid.RowDefinitions><RowDefinition Height="50"/><RowDefinition Height="*"/><RowDefinition Height="74"/></Grid.RowDefinitions>
<Border x:Name="Header" Background="#294c39" CornerRadius="23,23,0,0"><DockPanel Margin="20,0,10,0"><TextBlock Text="捞鱼的网络工具 · 安装" Foreground="#fffdf7" VerticalAlignment="Center"/><StackPanel Orientation="Horizontal" HorizontalAlignment="Right"><Button x:Name="Minimize" Content="—" Background="Transparent" Foreground="#fffdf7"/><Button x:Name="Close" Content="×" Background="Transparent" Foreground="#fffdf7"/></StackPanel></DockPanel></Border>
<Grid Grid.Row="1" Margin="34,24">
<StackPanel x:Name="Welcome"><Image x:Name="Mascot" Width="105" Height="105"/><TextBlock Text="让网络顺顺畅畅" FontSize="28" FontWeight="Bold" HorizontalAlignment="Center" Margin="0,10"/><TextBlock x:Name="VersionText" HorizontalAlignment="Center" Foreground="#788276"/><TextBlock Text="检查网络、按故障修复，并可选择定时保活。" HorizontalAlignment="Center" Margin="0,22,0,10"/><TextBlock Text="保活和超时自动重启默认关闭，安装后由你开启。" HorizontalAlignment="Center" Foreground="#788276"/><TextBlock Text="建议安装到 D 盘或其他数据盘，给系统盘留下空间。" HorizontalAlignment="Center" Margin="0,25,0,0" FontWeight="Bold"/></StackPanel>
<StackPanel x:Name="Location" Visibility="Collapsed"><TextBlock Text="把工具放在哪里？" FontSize="26" FontWeight="Bold"/><TextBlock Text="点击盘符快速选择，也可以输入完整路径。" Foreground="#788276" Margin="0,12"/><WrapPanel x:Name="Drives"/><TextBlock Text="安装目录 · 高手模式可直接修改" Margin="4,18,0,8"/><TextBox x:Name="InstallPath"/><WrapPanel><Button x:Name="Browse" Content="逐层选择文件夹"/><Button x:Name="Recommended" Content="使用推荐位置"/></WrapPanel><CheckBox x:Name="Desktop" Content="创建桌面快捷方式" IsChecked="True"/><TextBlock Text="开始菜单与卸载入口会保留。设置和日志独立存储。" Foreground="#788276" FontSize="12"/></StackPanel>
<StackPanel x:Name="Folders" Visibility="Collapsed"><TextBlock Text="选择文件夹" FontSize="26" FontWeight="Bold"/><TextBox x:Name="FolderPath" Margin="0,12"/><WrapPanel><Button x:Name="FolderUp" Content="上一级"/><Button x:Name="FolderOpen" Content="查看此目录"/></WrapPanel><StackPanel x:Name="FolderList"/><WrapPanel><Button x:Name="FolderPrevious" Content="上一页"/><Button x:Name="FolderNext" Content="下一页"/><Button x:Name="FolderChoose" Content="放在这里"/><Button x:Name="FolderCancel" Content="返回"/></WrapPanel></StackPanel>
<StackPanel x:Name="Progress" Visibility="Collapsed" VerticalAlignment="Center"><Image x:Name="ProgressMascot" Width="95" Height="95"/><TextBlock Text="正在安顿网络工具…" FontSize="26" FontWeight="Bold" HorizontalAlignment="Center" Margin="0,20"/><Border Background="#e4ecdc" CornerRadius="8" Height="16" Margin="0,14"><Grid><Border x:Name="ProgressFill" HorizontalAlignment="Left" Background="#294c39" CornerRadius="8" Width="0"/></Grid></Border><TextBlock x:Name="ProgressText" Text="准备安装，不要关闭窗口。" HorizontalAlignment="Center" Foreground="#788276"/></StackPanel>
<StackPanel x:Name="Finish" Visibility="Collapsed" VerticalAlignment="Center"><Image x:Name="FinishMascot" Width="110" Height="110"/><TextBlock Text="安装完成，网络工具已就位" FontSize="25" FontWeight="Bold" HorizontalAlignment="Center" Margin="0,18"/><TextBlock x:Name="InstalledText" HorizontalAlignment="Center" Foreground="#788276"/><CheckBox x:Name="Launch" Content="完成后打开网络工具" IsChecked="True" HorizontalAlignment="Center" Margin="0,24"/></StackPanel>
<TextBlock x:Name="ErrorText" VerticalAlignment="Bottom" Foreground="#a74d3a" TextWrapping="Wrap" Margin="0,0,0,-12"/>
</Grid><DockPanel Grid.Row="2" Margin="30,8,30,16"><TextBlock Text="捞鱼工作室 · 免费开源" Foreground="#788276" VerticalAlignment="Center"/><Button x:Name="Next" Content="开始安装" Background="#294c39" Foreground="#fffdf7" HorizontalAlignment="Right" MinWidth="120"/></DockPanel>
</Grid></Border></Window>
'@
$window=[Windows.Markup.XamlReader]::Parse($xaml);$ui=@{}
$window.Title='捞鱼的网络工具安装'
foreach($name in @('Header','Minimize','Close','Welcome','Location','Folders','Progress','Finish','Mascot','VersionText','Drives','InstallPath','Browse','Recommended','Desktop','FolderPath','FolderUp','FolderOpen','FolderList','FolderPrevious','FolderNext','FolderChoose','FolderCancel','ProgressMascot','ProgressFill','ProgressText','FinishMascot','InstalledText','Launch','ErrorText','Next')){$ui[$name]=$window.FindName($name)}
$script:page='Welcome';$script:installing=$false;$script:installerProcess=$null;$script:folders=@();$script:folderOffset=0;$script:root=''
foreach($name in @('Mascot','ProgressMascot','FinishMascot')){if($Logo -and [IO.File]::Exists($Logo)){$ui[$name].Source=New-Object Windows.Media.Imaging.BitmapImage([Uri]$Logo)}}
$ui.VersionText.Text='Windows x64 · '+$Version
$drives=@([IO.DriveInfo]::GetDrives()|Where-Object{$_.IsReady -and $_.DriveType -eq [IO.DriveType]::Fixed})
$recommended=$drives|Where-Object{$_.Name.TrimEnd('\') -ne $env:SystemDrive -and $_.AvailableFreeSpace -ge 700MB}|Select-Object -First 1
$defaultPath=if($recommended){Join-Path $recommended.Name 'LaoyuApps\LaoyuNetTools'}else{Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\LaoyuNetTools'}
$existing=@(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -eq '捞鱼的网络工具' -and $_.InstallLocation})|Select-Object -First 1
if($existing){$defaultPath=[string]$existing.InstallLocation}
$ui.InstallPath.Text=$defaultPath
function Set-Page([string]$name){foreach($p in @('Welcome','Location','Folders','Progress','Finish')){$ui[$p].Visibility=if($p -eq $name){'Visible'}else{'Collapsed'}};$script:page=$name;$ui.ErrorText.Text=''}
function Populate-Folders{
 $ui.FolderList.Children.Clear();$count=[Math]::Min(5,[Math]::Max(0,$script:folders.Count-$script:folderOffset))
 for($i=0;$i -lt $count;$i++){$folder=$script:folders[$script:folderOffset+$i];$b=New-Object Windows.Controls.Button;$b.Content=[IO.Path]::GetFileName($folder);$b.Tag=$folder;$b.HorizontalContentAlignment='Left';$b.Padding='12,6';$b.Add_Click({$ui.FolderPath.Text=[string]$this.Tag;Load-Folders});$null=$ui.FolderList.Children.Add($b)}
 $ui.FolderPrevious.IsEnabled=$script:folderOffset -gt 0;$ui.FolderNext.IsEnabled=$script:folderOffset+5 -lt $script:folders.Count
}
function Load-Folders{try{$folder=[IO.Path]::GetFullPath($ui.FolderPath.Text);if(![IO.Directory]::Exists($folder)){throw '目录不存在'};$ui.FolderPath.Text=$folder;$script:folders=@([IO.Directory]::EnumerateDirectories($folder)|Select-Object -First 200);$script:folderOffset=0;Populate-Folders}catch{$ui.ErrorText.Text='无法读取这个目录，请输入可访问的文件夹。'}}
foreach($drive in $drives){$b=New-Object Windows.Controls.Button;$b.Content=$drive.Name.TrimEnd('\');$b.Tag=$drive.Name;$b.Add_Click({$ui.InstallPath.Text=Join-Path ([string]$this.Tag) 'LaoyuApps\LaoyuNetTools'});$null=$ui.Drives.Children.Add($b)}
$ui.Header.Add_MouseLeftButtonDown({$source=$args[1].OriginalSource;while($source -and $source -ne $ui.Header){if($source -is [Windows.Controls.Button]){return};$source=[Windows.Media.VisualTreeHelper]::GetParent($source)};$window.DragMove()})
$ui.Minimize.Add_Click({$window.WindowState='Minimized'});$ui.Close.Add_Click({if(!$script:installing){$window.Close()}})
$window.Add_Closing({if($script:installing){$args[1].Cancel=$true}})
$ui.Browse.Add_Click({$ui.FolderPath.Text=[IO.Path]::GetPathRoot($ui.InstallPath.Text);Set-Page 'Folders';Load-Folders})
$ui.Recommended.Add_Click({$ui.InstallPath.Text=$defaultPath})
$ui.FolderOpen.Add_Click({Load-Folders});$ui.FolderUp.Add_Click({$parent=[IO.Directory]::GetParent($ui.FolderPath.Text);if($parent){$ui.FolderPath.Text=$parent.FullName;Load-Folders}})
$ui.FolderPrevious.Add_Click({$script:folderOffset=[Math]::Max(0,$script:folderOffset-5);Populate-Folders});$ui.FolderNext.Add_Click({$script:folderOffset+=5;Populate-Folders})
$ui.FolderChoose.Add_Click({$ui.InstallPath.Text=Join-Path $ui.FolderPath.Text 'LaoyuNetTools';Set-Page 'Location'});$ui.FolderCancel.Add_Click({Set-Page 'Location'})
$timer=New-Object Windows.Threading.DispatcherTimer;$timer.Interval=[TimeSpan]::FromMilliseconds(400)
$timer.Add_Tick({
 try{
  if(!$script:installerProcess.HasExited){$released=0;if([IO.Directory]::Exists($script:root)){foreach($file in ([IO.Directory]::EnumerateFiles($script:root,'*',[IO.SearchOption]::AllDirectories)|Select-Object -First 5000)){try{$released+=(New-Object IO.FileInfo($file)).Length}catch{}}};$percent=[Math]::Min(95,[Math]::Floor(100*$released/[Math]::Max(1,$PayloadBytes)));$ui.ProgressFill.Width=630*$percent/100;$ui.ProgressText.Text='释放文件 '+$percent+'% · 请稍候';return}
  $timer.Stop();$script:installing=$false;$ui.Close.IsEnabled=$true;$ui.Next.IsEnabled=$true
  if($script:installerProcess.ExitCode -ne 0){throw ('安装未完成（代码 '+$script:installerProcess.ExitCode+'），可以重试。')}
  $exe=Join-Path $script:root 'LaoyuNetTools.exe';$source=Join-Path $script:root 'resources\app\package.json'
  if(![IO.File]::Exists($exe) -or ![IO.File]::Exists($source) -or (([IO.File]::ReadAllText($source,[Text.Encoding]::UTF8)|ConvertFrom-Json).version -ne $Version)){throw '安装版本校验未通过，请重新下载完整包。'}
  $record=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -eq '捞鱼的网络工具' -and $_.DisplayVersion -eq $Version -and ([string]$_.InstallLocation).TrimEnd('\') -eq $script:root.TrimEnd('\')}|Select-Object -First 1
  if(!$record){throw '安装登记未通过校验，请重试。'}
  $ui.InstalledText.Text=$Version+' · '+$script:root;$ui.ProgressFill.Width=630;Set-Page 'Finish';$ui.Next.Content='完成'
 }catch{
  if($script:installerProcess -and !$script:installerProcess.HasExited){$ui.ProgressText.Text='安装仍在进行，暂时无法计算进度；请等待完成。';return}
  $timer.Stop();$script:installing=$false;$ui.Close.IsEnabled=$true;$ui.Next.IsEnabled=$true;Set-Page 'Location';$ui.ErrorText.Text=$_.Exception.Message;$ui.Next.Content='重试安装'
 }
})
$ui.Next.Add_Click({
 if($script:page -eq 'Welcome'){Set-Page 'Location';$ui.Next.Content='确认并安装';return}
 if($script:page -eq 'Finish'){if($ui.Launch.IsChecked){Start-Process -FilePath (Join-Path $script:root 'LaoyuNetTools.exe') -WindowStyle Normal};$window.Close();return}
 if($script:page -ne 'Location'){return}
 try{
  $value=$ui.InstallPath.Text.Trim();if($value -notmatch '^[A-Za-z]:\\' -or $value -match '[<>"|?*]' -or $value.Contains('/') -or $value.Length -gt 220){throw '请输入盘符开头的本地完整路径。'}
  $script:root=[IO.Path]::GetFullPath($value).TrimEnd('\');if([IO.Path]::GetFileName($script:root) -ne 'LaoyuNetTools'){$script:root=Join-Path $script:root 'LaoyuNetTools';$ui.InstallPath.Text=$script:root}
  $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($script:root));if($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.AvailableFreeSpace -lt 700MB){throw '请选择至少有 700 MB 空闲空间的本地磁盘。'}
  $cursor=$script:root;while($cursor){if([IO.Directory]::Exists($cursor)){$info=New-Object IO.DirectoryInfo($cursor);if(($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw '安装目录或父目录不能是符号链接或目录联接。'}};$parent=[IO.Directory]::GetParent($cursor);$cursor=if($parent){$parent.FullName}else{''}}
  if([IO.Directory]::Exists($script:root) -and [IO.Directory]::EnumerateFileSystemEntries($script:root).GetEnumerator().MoveNext()){$metadata=Join-Path $script:root 'resources\app\package.json';if(![IO.File]::Exists($metadata) -or (([IO.File]::ReadAllText($metadata,[Text.Encoding]::UTF8)|ConvertFrom-Json).name -ne 'laoyu-nettools')){throw '这个目录已有其他文件，请选择专用空目录。'}}
  $null=[IO.Directory]::CreateDirectory($script:root);$probe=Join-Path $script:root ('.nettools-write-'+[guid]::NewGuid().ToString()+'.tmp');$stream=[IO.File]::Open($probe,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$stream.Dispose();[IO.File]::Delete($probe)
  $options='/S';if(!$ui.Desktop.IsChecked){$options+=' --no-desktop-shortcut'};$options+=' /D='+$script:root
  if(![IO.File]::Exists($Installer)){throw '安装包已移动，请重新打开完整安装包。'}
  $script:installing=$true;$ui.Close.IsEnabled=$false;$ui.Next.IsEnabled=$false;Set-Page 'Progress';$script:installerProcess=Start-Process -FilePath $Installer -ArgumentList $options -PassThru -WindowStyle Hidden;$timer.Start()
 }catch{$script:installing=$false;$ui.Close.IsEnabled=$true;$ui.Next.IsEnabled=$true;$ui.ErrorText.Text=$_.Exception.Message}
})
if($env:CI -eq 'true' -and $env:NETTOOLS_INSTALLER_ACCEPTANCE_ROOT -and $env:RUNNER_TEMP){
 # Exercise the same visible WPF window and installation handlers in an
 # ephemeral runner. No preview installer or fake completion page is used.
 $testRoot=[IO.Path]::GetFullPath($env:NETTOOLS_INSTALLER_ACCEPTANCE_ROOT);$runnerRoot=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
 if(!$testRoot.StartsWith($runnerRoot,[StringComparison]::OrdinalIgnoreCase)){throw '安装验收目录必须位于隔离 runner 临时目录'}
 $evidence=Join-Path $runnerRoot 'nettools-installer-evidence';$null=[IO.Directory]::CreateDirectory($evidence)
 function Capture-Installer([string]$name){$window.UpdateLayout();$bitmap=New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$window.ActualWidth,[int]$window.ActualHeight,96,96,[Windows.Media.PixelFormats]::Pbgra32);$bitmap.Render($window);$encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder;$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap));$stream=[IO.File]::Create((Join-Path $evidence ($name+'.png')));try{$encoder.Save($stream)}finally{$stream.Dispose()}}
 $testTimer=New-Object Windows.Threading.DispatcherTimer;$testTimer.Interval=[TimeSpan]::FromMilliseconds(250);$script:testPhase=0;$script:testUntil=[DateTime]::UtcNow.AddMinutes(3)
 $testTimer.Add_Tick({
  try{
   if([DateTime]::UtcNow -gt $script:testUntil){throw '真实安装向导超时'}
   if($script:testPhase -eq 0){Capture-Installer '01-welcome';$ui.Next.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)));$ui.InstallPath.Text=$testRoot;$ui.Desktop.IsChecked=$false;Capture-Installer '02-location';$ui.Next.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)));$script:testPhase=1;return}
   if($script:page -eq 'Finish'){
    Capture-Installer '03-finish';$report=@{ok=$true;visible=$window.IsVisible;version=$Version;installRoot=$script:root;desktopSelected=$ui.Desktop.IsChecked;installerEntry=$Installer};[IO.File]::WriteAllText((Join-Path $evidence 'installer-report.json'),($report|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)));$testTimer.Stop();$ui.Launch.IsChecked=$false;$ui.Next.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)));return
   }
   if($script:page -eq 'Location' -and $ui.ErrorText.Text){throw $ui.ErrorText.Text}
  }catch{$report=@{ok=$false;error=$_.Exception.Message;visible=$window.IsVisible};[IO.File]::WriteAllText((Join-Path $evidence 'installer-report.json'),($report|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)));$testTimer.Stop();if(!$script:installing){$window.Close()}}
 })
 $window.Add_ContentRendered({$testTimer.Start()})
}
$null=$window.ShowDialog();$timer.Stop()
