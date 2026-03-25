@echo off
setlocal
set INSTALL_DIR=%~1
set AGENT_DIR=%INSTALL_DIR%\resources\agent
set NODE_EXE=%INSTALL_DIR%\resources\node\node.exe
:: package.json extraResources copies resources/win/ → win/
:: so nssm.exe lands at <installDir>\resources\win\nssm.exe
set NSSM=%INSTALL_DIR%\resources\win\nssm.exe

echo Installing Maque OMS VPN Agent...

:: Stop and remove existing service
net stop MaqueAgent 2>nul
sc delete MaqueAgent 2>nul
timeout /t 2 /nobreak >nul

:: Install service with NSSM
"%NSSM%" install MaqueAgent "%NODE_EXE%" "%AGENT_DIR%\index.js"
"%NSSM%" set MaqueAgent AppDirectory "%AGENT_DIR%"
"%NSSM%" set MaqueAgent Start SERVICE_AUTO_START
"%NSSM%" set MaqueAgent ObjectName LocalSystem
"%NSSM%" set MaqueAgent AppStdout "%AGENT_DIR%\agent.log"
"%NSSM%" set MaqueAgent AppStderr "%AGENT_DIR%\agent-error.log"
net start MaqueAgent

echo VPN Agent installed successfully.
endlocal