!include "${BUILD_RESOURCES_DIR}\installer-payload.nsh"
!macro preInit
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${Silent}
      InitPluginsDir
      File /oname=$PLUGINSDIR\nettools-installer.ps1 "${BUILD_RESOURCES_DIR}\installer-ui.ps1"
      File /oname=$PLUGINSDIR\nettools-logo.png "${BUILD_RESOURCES_DIR}\installer-logo.png"
      ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File "$PLUGINSDIR\nettools-installer.ps1" -Installer "$EXEPATH" -Version "${VERSION}" -PayloadBytes ${NETTOOLS_PAYLOAD_BYTES} -Logo "$PLUGINSDIR\nettools-logo.png"' $0
      SetErrorLevel $0
      Quit
    ${EndIf}
  !endif
!macroend
!macro customInit
  ; Keep an existing installation path on upgrades. New installs prefer a data drive.
  !insertmacro GetDParameter $R0
  ${If} $hasPerUserInstallation == "0"
  ${AndIf} $hasPerMachineInstallation == "0"
  ${AndIf} $R0 == ""
    ${If} ${FileExists} "D:\"
      StrCpy $INSTDIR "D:\LaoyuApps\LaoyuNetTools"
    ${ElseIf} ${FileExists} "E:\"
      StrCpy $INSTDIR "E:\LaoyuApps\LaoyuNetTools"
    ${EndIf}
  ${EndIf}
!macroend
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用捞鱼的网络工具"
  !define MUI_WELCOMEPAGE_TEXT "检查网络、按故障修复，并可选择定时保活。$\r$\n$\r$\n建议将软件安装到 D 盘或其他数据盘，给系统盘留下空间。下一步可以选择安装位置。$\r$\n$\r$\n保活与自动重启默认关闭，安装后由你自行开启。"
  !insertmacro MUI_PAGE_WELCOME
!macroend
