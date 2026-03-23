const http  = require('http')
const fs    = require('fs')
const path  = require('path')
const { exec, execSync } = require('child_process')
const crypto = require('crypto')

const PORT        = 51821
const IS_WIN      = process.platform === 'win32'
const IS_MAC      = process.platform === 'darwin'

const CONF_DIR    = IS_WIN
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'MaqueOMS')
    : '/etc/wireguard'
const CONF_PATH   = path.join(CONF_DIR, 'maque.conf')
const CONF_NAME   = 'maque'
const WG_BIN      = IS_WIN ? path.join(__dirname, 'wg', 'wg.exe')       : '/opt/maque-agent/wg/wg'
const WGQUICK     = IS_WIN ? path.join(__dirname, 'wg', 'wireguard.exe') : '/opt/maque-agent/wg/wg-quick'
const BASH        = '/opt/homebrew/bin/bash'
const SECRET_FILE = IS_WIN
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'MaqueOMS', 'agent.secret')
    : '/etc/maque-agent.secret'

// ── Secret ────────────────────────────────────────────────────────
function getSecret() {
    try { return fs.readFileSync(SECRET_FILE, 'utf8').trim() } catch { return null }
}
function ensureSecret() {
    if (!getSecret()) {
        fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true })
        fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o644 })
        console.log('[maque-agent] generated new API secret')
    }
}

// ── VPN ───────────────────────────────────────────────────────────
function isVpnConnected() {
    try {
        if (IS_MAC) {
            const out = execSync('/sbin/ifconfig', { encoding: 'utf8', timeout: 2000 })
            // utun4+ with mtu 1420 is WireGuard (standard utun are mtu 1380/1500/2000)
            return out.includes('utun4') || out.includes('utun5') || out.includes('utun6')
        }
        execSync(`ping -n 1 -w 1000 10.0.0.1`, { stdio: 'ignore', timeout: 2000 })
        return true
    } catch { return false }
}

function hasConf() { return fs.existsSync(CONF_PATH) }

function ensureConfDir() {
    if (!fs.existsSync(CONF_DIR)) fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 })
}

function saveConf(content) {
    ensureConfDir()
    fs.writeFileSync(CONF_PATH, content, { mode: 0o600 })
}

function vpnUp() {
    return new Promise((resolve) => {
        // Already connected — skip
        if (isVpnConnected()) {
            console.log('[agent] VPN already connected, skipping wg-quick up')
            return resolve({ success: true, already_connected: true })
        }
        const cmd = IS_WIN
            ? `"${WGQUICK}" /installtunnelservice "${CONF_PATH}"`
            : `${BASH} "${WGQUICK}" up "${CONF_PATH}"`
        exec(cmd, (err, stdout, stderr) => {
            const output = (stderr + stdout).trim()
            if (!err || output.includes('already exists')) {
                console.log('[agent] VPN up:', output || 'ok')
                resolve({ success: true })
            } else {
                console.error('[agent] vpnUp error:', output)
                resolve({ success: false, error: output })
            }
        })
    })
}

function vpnDown() {
    return new Promise((resolve) => {
        const cmd = IS_WIN
            ? `"${WGQUICK}" /uninstalltunnelservice "${CONF_NAME}"`
            : `${BASH} "${WGQUICK}" down "${CONF_PATH}"`
        exec(cmd, (err, stdout, stderr) => {
            resolve({ success: !err, error: stderr })
        })
    })
}

// ── HTTP server ───────────────────────────────────────────────────
function sendJson(res, code, data) {
    const body = JSON.stringify(data)
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
}

function readBody(req) {
    return new Promise(resolve => {
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
    })
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const secret = getSecret()
    if (secret && req.headers['x-api-key'] !== secret) {
        return sendJson(res, 403, { error: 'Unauthorized' })
    }

    if (req.method === 'GET' && req.url === '/status') {
        return sendJson(res, 200, {
            connected: isVpnConnected(),
            has_conf:  hasConf(),
            platform:  process.platform,
        })
    }

    if (req.method === 'POST' && req.url === '/connect') {
        const body = await readBody(req)
        if (body.config) saveConf(body.config)
        if (!hasConf()) return sendJson(res, 400, { error: 'No config' })
        const result = await vpnUp()
        if (result.success) {
            // Wait up to 3s for interface to appear
            for (let i = 0; i < 6; i++) {
                await new Promise(r => setTimeout(r, 500))
                if (isVpnConnected()) break
            }
        }
        return sendJson(res, result.success ? 200 : 500, result)
    }

    if (req.method === 'POST' && req.url === '/disconnect') {
        const result = await vpnDown()
        return sendJson(res, 200, result)
    }

    if (req.method === 'POST' && req.url === '/save-config') {
        const body = await readBody(req)
        if (!body.config || !body.config.includes('[Interface]'))
            return sendJson(res, 400, { error: 'Invalid config' })
        saveConf(body.config)
        return sendJson(res, 200, { success: true })
    }

    sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[maque-agent] listening on 127.0.0.1:${PORT}`)
    ensureSecret()
})

process.on('SIGTERM', async () => {
    console.log('[maque-agent] shutting down')
    if (hasConf()) await vpnDown()
    process.exit(0)
})