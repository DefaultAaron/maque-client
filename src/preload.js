const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('maque', {
    isAgentRunning: () => ipcRenderer.invoke('is-agent-running'),
    isVpnConnected: () => ipcRenderer.invoke('is-vpn-connected'),
    loadToken:      () => ipcRenderer.invoke('load-token'),
    saveWgConfig:   (conf)  => ipcRenderer.invoke('save-wg-config', conf),
    startVpn:       (conf)  => ipcRenderer.invoke('start-vpn', conf),
    stopVpn:        () => ipcRenderer.invoke('stop-vpn'),
    login:          (creds) => ipcRenderer.invoke('login', creds),
    openMain:       (token) => ipcRenderer.invoke('open-main', token),
    clearConfig:    () => ipcRenderer.invoke('clear-config'),
})