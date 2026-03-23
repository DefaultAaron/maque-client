const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog } = require('electron')
const path  = require('path')
const fs    = require('fs')
const https = require('https')
const http  = require('http')

const OMS_URL      = 'https://maque-oms.top'
const VPN_GATEWAY  = '10.0.0.1'
const AGENT_URL    = 'http://127.0.0.1:51821'
const CONFIG_DIR   = path.join(app.getPath('userData'), 'config')
const TOKEN_PATH   = path.join(CONFIG_DIR, 'token.json')
const SECRET_PATH  = process.platform === 'win32'
    ? 'C:\\ProgramData\\MaqueOMS\\agent.secret'
    : '/etc/maque-agent.secret'
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

let mainWindow  = null
let setupWindow = null
let tray        = null

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

// ── Agent communication ───────────────────────────────────────────
function getAgentSecret() {
    try { return fs.readFileSync(SECRET_PATH, 'utf8').trim() }
    catch { return null }
}

function agentRequest(method, path, body = null) {
    return new Promise((resolve) => {
        const secret  = getAgentSecret()
        const payload = body ? JSON.stringify(body) : null
        const headers = { 'Content-Type': 'application/json' }
        if (secret) headers['x-api-key'] = secret
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload)

        const req = http.request({
            hostname: '127.0.0.1', port: 51821,
            path, method, headers,
        }, (res) => {
            let data = ''
            res.on('data', c => data += c)
            res.on('end', () => {
                try { resolve({ ok: res.statusCode < 300, ...JSON.parse(data) })
                } catch { resolve({ ok: false, error: 'Parse error' }) }
            })
        })
        req.on('error', () => resolve({ ok: false, error: 'Agent not running' }))
        if (payload) req.write(payload)
        req.end()
    })
}

async function isAgentRunning() {
    const r = await agentRequest('GET', '/status')
    return r.ok === true
}

async function isVpnConnected() {
    const r = await agentRequest('GET', '/status')
    return r.connected === true
}

async function connectVpn(config = null) {
    return await agentRequest('POST', '/connect', config ? { config } : {})
}

async function disconnectVpn() {
    return await agentRequest('POST', '/disconnect')
}

async function saveVpnConfig(config) {
    return await agentRequest('POST', '/save-config', { config })
}

// ── Token ─────────────────────────────────────────────────────────
function saveToken(token) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ token, saved_at: Date.now() }))
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
    setupWindow = new BrowserWindow({
        width: 460, height: 580, resizable: false,
        titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
        title: '麻雀OMS — 初始设置',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    })
    setupWindow.loadFile(path.join(__dirname, '..', 'ui', 'setup.html'))
    setupWindow.on('closed', () => { setupWindow = null })
}

function createMainWindow(token) {
    mainWindow = new BrowserWindow({
        width: 1280, height: 800, minWidth: 900, minHeight: 600,
        titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
        title: '麻雀OMS',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    })
    const startUrl = token
        ? `${OMS_URL}/auth/token-login?token=${encodeURIComponent(token)}`
        : OMS_URL
    mainWindow.loadURL(startUrl)
    mainWindow.webContents.on('will-navigate', (_, url) => {
        if (url.includes('/logout') || url.endsWith('/login')) clearToken()
    })
    mainWindow.on('closed', () => { mainWindow = null })
}

function createTray() {
    const img = nativeImage.createEmpty()
    tray = new Tray(img)
    tray.setToolTip('麻雀OMS')
    const updateMenu = async () => {
        const vpnOk = await isVpnConnected()
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: '打开麻雀OMS', click: () => mainWindow?.show() },
            { type: 'separator' },
            { label: vpnOk ? '✓ VPN已连接' : '✗ VPN未连接', enabled: false },
            { label: vpnOk ? '断开VPN' : '连接VPN', click: async () => {
                if (vpnOk) await disconnectVpn()
                else await connectVpn()
                updateMenu()
            }},
            { type: 'separator' },
            { label: '退出', click: () => app.quit() },
        ]))
    }
    updateMenu()
    tray.on('double-click', () => mainWindow?.show())
    // Refresh tray menu every 30s
    setInterval(updateMenu, 30000)
}

// ── IPC ───────────────────────────────────────────────────────────
ipcMain.handle('is-agent-running',  () => isAgentRunning())
ipcMain.handle('is-vpn-connected',  () => isVpnConnected())
ipcMain.handle('load-token',        () => loadToken())
ipcMain.handle('save-wg-config',    (_, conf) => saveVpnConfig(conf))
ipcMain.handle('start-vpn',         (_, conf) => connectVpn(conf))
ipcMain.handle('stop-vpn',          () => disconnectVpn())
ipcMain.handle('clear-config',      () => { clearToken(); return true })

ipcMain.handle('login', async (_, { username, password }) => {
    return new Promise(resolve => {
        const body = JSON.stringify({ username, password })
        const req = https.request({
            hostname: 'maque-oms.top', path: '/auth/login', method: 'POST',
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

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
    const agentOk = await isAgentRunning()
    if (!agentOk) { createSetupWindow(); return }

    const vpnOk = await isVpnConnected()
    if (!vpnOk) {
        // Show setup — let user paste config and connect
        createSetupWindow()
        return
    }

    const token = loadToken()
    if (!token) { createSetupWindow(); return }

    createMainWindow(token)
    createTray()
})

app.on('window-all-closed', () => { if (!IS_MAC) app.quit() })
app.on('activate', () => { if (mainWindow) mainWindow.show(); else if (!setupWindow) createSetupWindow() })
app.on('before-quit', () => disconnectVpn())