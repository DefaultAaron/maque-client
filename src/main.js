const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require('electron')
const path  = require('path')
const fs    = require('fs')
const https = require('https')
const http  = require('http')
const { isOcrInstalled, installOcr } = require('./ocr_setup')

// ── Constants ─────────────────────────────────────────────────────
const OMS_URL         = 'https://maque-oms.top'
const OMS_HOSTNAME    = 'maque-oms.top'
const SECRET_PATH     = process.platform === 'win32'
    ? 'C:\\ProgramData\\MaqueOMS\\agent.secret'
    : '/etc/maque-agent.secret'
const OCR_SECRET_PATH = process.platform === 'win32'
    ? 'C:\\ProgramData\\MaqueOMS\\ocr.secret'
    : '/etc/maque-ocr.secret'
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// ── State ─────────────────────────────────────────────────────────
let CONFIG_DIR   = null
let TOKEN_PATH   = null
let mainWindow   = null
let setupWindow  = null
let cameraWindow = null
let tray         = null
let isQuitting   = false

// ── Path init ─────────────────────────────────────────────────────
function initPaths() {
    CONFIG_DIR = path.join(app.getPath('userData'), 'config')
    TOKEN_PATH = path.join(CONFIG_DIR, 'token.json')
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
}

// ── VPN agent ─────────────────────────────────────────────────────
function getAgentSecret() {
    try { return fs.readFileSync(SECRET_PATH, 'utf8').trim() } catch { return null }
}

function agentRequest(method, reqPath, body = null) {
    return new Promise((resolve) => {
        const secret  = getAgentSecret()
        const payload = body ? JSON.stringify(body) : null
        const headers = { 'Content-Type': 'application/json' }
        if (secret) headers['x-api-key'] = secret
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload)
        const req = http.request(
            { hostname: '127.0.0.1', port: 51821, path: reqPath, method, headers },
            (res) => {
                let data = ''
                res.on('data', c => data += c)
                res.on('end', () => {
                    try { resolve({ ok: res.statusCode < 300, ...JSON.parse(data) })
                    } catch { resolve({ ok: false, error: 'Parse error' }) }
                })
            }
        )
        req.on('error', () => resolve({ ok: false, error: 'Agent not running' }))
        if (payload) req.write(payload)
        req.end()
    })
}

const isAgentRunning = async () => (await agentRequest('GET', '/status')).ok === true
const isVpnConnected = async () => (await agentRequest('GET', '/status')).connected === true
const connectVpn     = (cfg = null) => agentRequest('POST', '/connect', cfg ? { config: cfg } : {})
const disconnectVpn  = () => agentRequest('POST', '/disconnect')
const saveVpnConfig  = (cfg) => agentRequest('POST', '/save-config', { config: cfg })

// ── OCR agent ─────────────────────────────────────────────────────
function getOcrSecret() {
    try { return fs.readFileSync(OCR_SECRET_PATH, 'utf8').trim() } catch { return null }
}

function ocrRequest(method, reqPath, body = null) {
    return new Promise((resolve) => {
        const secret  = getOcrSecret()
        const payload = body ? JSON.stringify(body) : null
        const headers = { 'Content-Type': 'application/json' }
        if (secret) headers['x-api-key'] = secret
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload)
        const req = http.request(
            { hostname: '127.0.0.1', port: 51822, path: reqPath, method, headers, timeout: 30000 },
            (res) => {
                let data = ''
                res.on('data', c => data += c)
                res.on('end', () => {
                    try { resolve({ ok: res.statusCode < 300, ...JSON.parse(data) })
                    } catch { resolve({ ok: false, error: 'Parse error' }) }
                })
            }
        )
        req.on('error',   () => resolve({ ok: false, error: 'OCR agent not running' }))
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'OCR timeout' }) })
        if (payload) req.write(payload)
        req.end()
    })
}

const isOcrAgentRunning = async () => (await ocrRequest('GET', '/status')).ok === true
const runOcr = (b64) => ocrRequest('POST', '/ocr', { image: b64 })

// ── Token ─────────────────────────────────────────────────────────
function saveToken(t) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ token: t, saved_at: Date.now() }))
}
function loadToken() {
    try {
        if (!fs.existsSync(TOKEN_PATH)) return null
        const d = JSON.parse(fs.readFileSync(TOKEN_PATH))
        if (Date.now() - d.saved_at > 8 * 3600 * 1000) { fs.unlinkSync(TOKEN_PATH); return null }
        return d.token
    } catch { return null }
}
function clearToken() { try { fs.unlinkSync(TOKEN_PATH) } catch {} }

// ── Windows ───────────────────────────────────────────────────────
function createSetupWindow() {
    if (setupWindow) { setupWindow.focus(); return }
    setupWindow = new BrowserWindow({
        width: 460, height: 600, resizable: false,
        titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
        title: '麻雀OMS — 初始设置',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    })
    setupWindow.loadFile(path.join(__dirname, '..', 'ui', 'setup.html'))
    setupWindow.on('closed', () => { setupWindow = null })
}

function createMainWindow(token) {
    if (mainWindow) { mainWindow.focus(); return }
    mainWindow = new BrowserWindow({
        width: 1280, height: 800, minWidth: 900, minHeight: 600,
        titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
        title: '麻雀OMS',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    })
    const url = token
        ? `${OMS_URL}/auth/token-login?token=${encodeURIComponent(token)}`
        : OMS_URL
    mainWindow.loadURL(url)
    mainWindow.webContents.on('will-navigate', (_, u) => {
        if (u.includes('/logout') || u.endsWith('/login')) clearToken()
    })
    mainWindow.on('closed', () => { mainWindow = null })
}

function createTray() {
    if (tray) return
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png')
    const img = fs.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath)
        : nativeImage.createEmpty()
    tray = new Tray(img)
    tray.setToolTip('麻雀OMS')
    const updateMenu = async () => {
        const vpnOk = await isVpnConnected()
        const ocrOk = isOcrInstalled()
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: '打开麻雀OMS', click: () => mainWindow?.show() },
            { type: 'separator' },
            { label: vpnOk ? '✓ VPN已连接' : '✗ VPN未连接', enabled: false },
            { label: vpnOk ? '断开VPN' : '连接VPN', click: async () => {
                vpnOk ? await disconnectVpn() : await connectVpn()
                updateMenu()
            }},
            { type: 'separator' },
            // Show OCR install option in tray if not yet installed
            ...(!ocrOk ? [{ label: '⬇ 安装OCR扫描功能', click: () => {
                createSetupWindow()
                // Small delay so window is ready before we trigger the step
                setTimeout(() => setupWindow?.webContents.send('goto-ocr-setup'), 500)
            }}] : []),
            { type: 'separator' },
            { label: '退出', click: () => { isQuitting = true; app.quit() } },
        ]))
    }
    updateMenu()
    tray.on('double-click', () => mainWindow?.show())
    setInterval(updateMenu, 30000)
}

// ── OCR form URL builder ──────────────────────────────────────────
function ocrResultToFormUrl(result) {
    if (!result.ok) return null
    const { fields, confidence } = result
    const params   = new URLSearchParams({ ocr: '1' })
    const fieldMap = {
        waybill_number:    'order_number',
        gross_weight:      'gross_weight',
        chargeable_weight: 'weight',
        piece_count:       'item_number',
        flight_code:       'flight_code',
        flight_date:       'date',
        destination:       'destination',
        item_description:  'item_name',
    }
    for (const [ocrKey, formKey] of Object.entries(fieldMap)) {
        if (fields[ocrKey] != null) {
            params.set(formKey, String(fields[ocrKey]))
            params.set(`ocr_conf_${formKey}`, String(confidence[ocrKey] ?? 0))
        }
    }
    return `${OMS_URL}/orders/new?${params.toString()}`
}

// ── IPC: VPN ──────────────────────────────────────────────────────
ipcMain.handle('is-agent-running', () => isAgentRunning())
ipcMain.handle('is-vpn-connected', () => isVpnConnected())
ipcMain.handle('load-token',       () => loadToken())
ipcMain.handle('save-wg-config',   (_, c) => saveVpnConfig(c))
ipcMain.handle('start-vpn',        (_, c) => connectVpn(c))
ipcMain.handle('stop-vpn',         () => disconnectVpn())
ipcMain.handle('clear-config',     () => { clearToken(); return true })

// ── IPC: Auth ─────────────────────────────────────────────────────
ipcMain.handle('login', async (_, { username, password }) => {
    return new Promise(resolve => {
        const body = JSON.stringify({ username, password })
        const req  = https.request({
            hostname: OMS_HOSTNAME, path: '/auth/login', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
            let data = ''
            res.on('data', c => data += c)
            res.on('end', () => {
                try {
                    const j = JSON.parse(data)
                    if (j.access_token) { saveToken(j.access_token); resolve({ success: true, token: j.access_token }) }
                    else resolve({ success: false, error: j.detail || '用户名或密码错误' })
                } catch { resolve({ success: false, error: '服务器响应错误' }) }
            })
        })
        req.on('error', () => resolve({ success: false, error: '无法连接服务器，请检查VPN连接' }))
        req.write(body); req.end()
    })
})

ipcMain.handle('open-main', async (_, token) => {
    setupWindow?.close()
    createMainWindow(token)
    createTray()
})

// ── IPC: OCR setup ────────────────────────────────────────────────
ipcMain.handle('ocr-is-installed', () => isOcrInstalled())
ipcMain.handle('ocr-is-running',   () => isOcrAgentRunning())

ipcMain.handle('ocr-install', async () => {
    const win  = setupWindow
    const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data) }
    try {
        await installOcr(
            app.getAppPath(),
            (label, idx, total) => send('ocr-step',     { label, idx, total }),
            (pct,   detail)     => send('ocr-progress',  { pct, detail }),
            (line)              => send('ocr-log',        { line }),
        )
        return { ok: true }
    } catch (err) {
        send('ocr-log', { line: `ERROR: ${err.message}` })
        return { ok: false, error: err.message }
    }
})

// ── IPC: Camera / OCR scan ────────────────────────────────────────
ipcMain.handle('open-camera', () => {
    if (cameraWindow) { cameraWindow.focus(); return }
    cameraWindow = new BrowserWindow({
        width: 680, height: 520, resizable: true,
        title: '扫描运单',
        parent: mainWindow,
        titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    })
    cameraWindow.loadFile(path.join(__dirname, '..', 'ui', 'camera.html'))
    cameraWindow.on('closed', () => { cameraWindow = null })
})

ipcMain.handle('process-ocr-image', async (_, imageBase64) => {
    const result = await runOcr(imageBase64)
    if (!result.ok) return { ok: false, error: result.error }
    const url = ocrResultToFormUrl(result)
    mainWindow?.loadURL(url)
    cameraWindow?.close()
    return { ok: true }
})

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
    initPaths()
    const agentOk = await isAgentRunning()
    if (!agentOk) { createSetupWindow(); return }
    const vpnOk = await isVpnConnected()
    if (!vpnOk)   { createSetupWindow(); return }
    const token = loadToken()
    if (!token)   { createSetupWindow(); return }
    createMainWindow(token)
    createTray()
})

app.on('window-all-closed', () => { if (!IS_MAC) app.quit() })
app.on('activate', () => {
    if (mainWindow)        mainWindow.show()
    else if (!setupWindow) createSetupWindow()
})
app.on('before-quit', async (e) => {
    if (!isQuitting) {
        isQuitting = true
        e.preventDefault()
        await disconnectVpn()
        app.quit()
    }
})