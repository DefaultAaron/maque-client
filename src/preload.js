const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('maque', {
    // ── VPN ────────────────────────────────────────────────────────
    isAgentRunning:  () => ipcRenderer.invoke('is-agent-running'),
    isVpnConnected:  () => ipcRenderer.invoke('is-vpn-connected'),
    loadToken:       () => ipcRenderer.invoke('load-token'),
    saveWgConfig:    (conf)  => ipcRenderer.invoke('save-wg-config', conf),
    startVpn:        (conf)  => ipcRenderer.invoke('start-vpn', conf),
    stopVpn:         () => ipcRenderer.invoke('stop-vpn'),
    clearConfig:     () => ipcRenderer.invoke('clear-config'),

    // ── Auth ───────────────────────────────────────────────────────
    login:           (creds) => ipcRenderer.invoke('login', creds),
    openMain:        (token) => ipcRenderer.invoke('open-main', token),

    // ── OCR setup ──────────────────────────────────────────────────
    ocrIsInstalled:  () => ipcRenderer.invoke('ocr-is-installed'),
    ocrIsRunning:    () => ipcRenderer.invoke('ocr-is-running'),
    ocrInstall:      () => ipcRenderer.invoke('ocr-install'),

    // ── OCR scan ───────────────────────────────────────────────────
    openCamera:      () => ipcRenderer.invoke('open-camera'),
    processOcrImage: (b64) => ipcRenderer.invoke('process-ocr-image', b64),
})

// Push events from main → renderer (used by setup.html for OCR progress)
contextBridge.exposeInMainWorld('electronAPI', {
    onOcrStep:      (cb) => ipcRenderer.on('ocr-step',      (_, d) => cb(d)),
    onOcrProgress:  (cb) => ipcRenderer.on('ocr-progress',  (_, d) => cb(d)),
    onOcrLog:       (cb) => ipcRenderer.on('ocr-log',       (_, d) => cb(d)),
    onGotoOcrSetup: (cb) => ipcRenderer.on('goto-ocr-setup', () => cb()),
})