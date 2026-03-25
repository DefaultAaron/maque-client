; Custom NSIS hooks — run after main installation (elevated, no terminal)
; OCR runtime is NOT installed here — it downloads on first use via the app UI.

!macro customInstall
    DetailPrint "Installing VPN Agent service..."
    nsExec::ExecToLog '"$INSTDIR\resources\agent\install-agent.bat" "$INSTDIR"'
    Pop $0
    ${If} $0 != 0
        MessageBox MB_OK "VPN Agent安装失败，请以管理员身份重新运行安装程序。$\nVPN Agent installation failed. Please re-run as Administrator."
    ${EndIf}
!macroend

!macro customUnInstall
    DetailPrint "Removing VPN Agent service..."
    nsExec::ExecToLog 'net stop MaqueAgent'
    nsExec::ExecToLog 'sc delete MaqueAgent'

    DetailPrint "Removing OCR Agent service (if installed)..."
    nsExec::ExecToLog 'net stop MaqueOCR'
    nsExec::ExecToLog 'sc delete MaqueOCR'
!macroend
