; Custom NSIS hook — runs after main installation
!macro customInstall
    ; Install agent as Windows service using bundled node
    DetailPrint "Installing VPN Agent service..."
    nsExec::ExecToLog '"$INSTDIR\resources\agent\install-agent.bat" "$INSTDIR"'
    Pop $0
    ${If} $0 != 0
        MessageBox MB_OK "VPN Agent installation failed. Please run as Administrator."
    ${EndIf}
!macroend

!macro customUnInstall
    DetailPrint "Removing VPN Agent service..."
    nsExec::ExecToLog 'net stop MaqueAgent'
    nsExec::ExecToLog 'sc delete MaqueAgent'
!macroend
