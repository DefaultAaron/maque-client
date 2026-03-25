/**
 * ocr_setup.js  —  OCR runtime installer (runs in main process)
 *
 * Handles first-launch download of:
 *   1. Python embeddable package (Win) or checks system python3 (Mac)
 *   2. PaddleOCR wheels via pip (Tsinghua mirror for CN networks)
 *   3. PP-OCRv4 CH model files from Baidu BOS
 *
 * Progress is reported via a callback so setup.html can show a live bar.
 * Everything is cached to OCR_DATA_DIR — subsequent launches skip the download.
 *
 * Layout after install (Windows):
 *   %ProgramData%\MaqueOMS\ocr\
 *     python\          ← portable Python
 *     models\det|rec|cls\  ← PP-OCRv4 models
 *     ocr_agent.py     ← copied from app resources
 *     installed        ← sentinel file, presence = fully installed
 *
 * Layout after install (Mac):
 *   /opt/maque-ocr/
 *     models\det|rec|cls\
 *     ocr_agent.py
 *     installed
 */

const path    = require('path')
const fs      = require('fs')
const https   = require('https')
const http    = require('http')
const { exec, spawn } = require('child_process')

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// Where OCR runtime lives on the user machine (persistent across app updates)
const OCR_DATA_DIR = IS_WIN
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'MaqueOMS', 'ocr')
    : '/opt/maque-ocr'

const SENTINEL      = path.join(OCR_DATA_DIR, 'installed')
const PYTHON_DIR    = path.join(OCR_DATA_DIR, 'python')     // Win only
const MODELS_DIR    = path.join(OCR_DATA_DIR, 'models')
const AGENT_DEST    = path.join(OCR_DATA_DIR, 'ocr_agent.py')

// Python executable paths
const PY_WIN  = path.join(PYTHON_DIR, 'python.exe')
const PY_MAC  = '/usr/bin/python3'   // system Python — always present on macOS 12+

// pip mirror: Tsinghua University (reliable in mainland China)
const PIP_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'

// PaddleOCR wheel versions pinned for reproducibility
const PIP_PACKAGES = [
    'paddlepaddle==2.6.1',
    'paddleocr==2.7.3',
    'opencv-python-headless==4.9.0.80',
    'pillow==10.2.0',
    'numpy==1.26.4',
].join(' ')

// PP-OCRv4 Chinese models hosted on Baidu BOS (fast in China)
const MODELS = [
    {
        name: 'det',
        url:  'https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_det_infer.tar',
        dir:  path.join(MODELS_DIR, 'det'),
    },
    {
        name: 'rec',
        url:  'https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_rec_infer.tar',
        dir:  path.join(MODELS_DIR, 'rec'),
    },
    {
        name: 'cls',
        url:  'https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_cls_infer.tar',
        dir:  path.join(MODELS_DIR, 'cls'),
    },
]

// Node v18+ has no built-in tar — use the bundled tar on Windows / system tar on Mac
const TAR_BIN = IS_WIN
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')  // Win 10 1803+
    : 'tar'

// ── Utilities ─────────────────────────────────────────────────────────────────

function mkdirp(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * Download a URL to a local file path, reporting progress as 0–100.
 * @param {string} url
 * @param {string} dest  destination file path
 * @param {function} onProgress  (pct: number, label: string) => void
 */
function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http
        const doRequest = (reqUrl) => {
            proto.get(reqUrl, (res) => {
                // Follow redirects
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return doRequest(res.headers.location)
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`))
                }
                const total = parseInt(res.headers['content-length'] || '0', 10)
                let received = 0
                const out = fs.createWriteStream(dest)
                res.on('data', chunk => {
                    received += chunk.length
                    out.write(chunk)
                    if (total > 0) onProgress(Math.round(received / total * 100), '')
                })
                res.on('end', () => { out.end(); resolve() })
                res.on('error', reject)
                out.on('error', reject)
            }).on('error', reject)
        }
        doRequest(url)
    })
}

/**
 * Run a command, streaming stdout/stderr lines to onLog.
 */
function runCmd(cmd, args, opts, onLog) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
        proc.stdout.on('data', d => onLog(d.toString().trim()))
        proc.stderr.on('data', d => onLog(d.toString().trim()))
        proc.on('close', code => {
            if (code === 0) resolve()
            else reject(new Error(`Command exited ${code}: ${cmd} ${args.join(' ')}`))
        })
        proc.on('error', reject)
    })
}

// ── Step implementations ───────────────────────────────────────────────────────

async function stepPythonWin(onProgress, onLog) {
    if (fs.existsSync(PY_WIN)) { onLog('Portable Python already present.'); return }
    onLog('Downloading portable Python for Windows...')
    const PY_VER  = '3.11.8'
    const PY_URL  = `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`
    const zipPath = path.join(OCR_DATA_DIR, 'python.zip')
    mkdirp(PYTHON_DIR)
    await downloadFile(PY_URL, zipPath, (pct) => onProgress(pct, 'Python'))
    onLog('Extracting Python...')
    await runCmd(TAR_BIN, ['-xf', zipPath, '-C', PYTHON_DIR], {}, onLog)
    fs.unlinkSync(zipPath)

    // Uncomment 'import site' so pip-installed packages are visible
    const pthFiles = fs.readdirSync(PYTHON_DIR).filter(f => f.endsWith('._pth'))
    for (const f of pthFiles) {
        const p = path.join(PYTHON_DIR, f)
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^#import site/m, 'import site'))
    }

    // Bootstrap pip
    onLog('Installing pip...')
    const getPipUrl  = 'https://bootstrap.pypa.io/get-pip.py'
    const getPipPath = path.join(OCR_DATA_DIR, 'get-pip.py')
    await downloadFile(getPipUrl, getPipPath, () => {})
    await runCmd(PY_WIN, [getPipPath, '--quiet'], {}, onLog)
    fs.unlinkSync(getPipPath)
    onLog('Python ready.')
}

async function stepPipInstall(pyExe, onProgress, onLog) {
    onLog('Installing PaddleOCR (this may take a few minutes)...')
    // Split packages so we can report per-package progress
    const pkgs = PIP_PACKAGES.split(' ')
    for (let i = 0; i < pkgs.length; i++) {
        onLog(`  pip install ${pkgs[i]}`)
        await runCmd(pyExe, [
            '-m', 'pip', 'install', pkgs[i],
            '-i', PIP_MIRROR,
            '--quiet', '--no-warn-script-location',
        ], {}, onLog)
        onProgress(Math.round((i + 1) / pkgs.length * 100), 'PaddleOCR')
    }
    onLog('PaddleOCR installed.')
}

async function stepDownloadModels(onProgress, onLog) {
    mkdirp(MODELS_DIR)
    for (let i = 0; i < MODELS.length; i++) {
        const m = MODELS[i]
        if (fs.existsSync(m.dir) && fs.readdirSync(m.dir).length > 0) {
            onLog(`Model ${m.name} already present.`)
            onProgress(Math.round((i + 1) / MODELS.length * 100), `模型 ${m.name}`)
            continue
        }
        mkdirp(m.dir)
        onLog(`Downloading model: ${m.name}...`)
        const tarPath = path.join(MODELS_DIR, `${m.name}.tar`)
        await downloadFile(m.url, tarPath, (pct) => {
            const overall = Math.round((i / MODELS.length + pct / 100 / MODELS.length) * 100)
            onProgress(overall, `模型 ${m.name} ${pct}%`)
        })
        onLog(`Extracting ${m.name}...`)
        await runCmd(TAR_BIN, ['-xf', tarPath, '-C', m.dir, '--strip-components=1'], {}, onLog)
        fs.unlinkSync(tarPath)
        onLog(`Model ${m.name} ready.`)
    }
}

async function stepCopyAgent(appResourcesDir, onLog) {
    const src = path.join(appResourcesDir, 'ocr', 'ocr_agent.py')
    if (!fs.existsSync(src)) throw new Error(`ocr_agent.py not found in app resources: ${src}`)
    fs.copyFileSync(src, AGENT_DEST)
    onLog('OCR agent script deployed.')
}

async function stepRegisterService(pyExe, onLog) {
    if (IS_WIN) {
        const nssmDir  = path.join(process.resourcesPath || '', 'resources', 'win')
        const nssmExe  = path.join(nssmDir, 'nssm.exe')
        if (!fs.existsSync(nssmExe)) throw new Error('nssm.exe not found')

        // Stop existing service silently before re-registering
        await runCmd('net', ['stop', 'MaqueOCR'], {}, () => {}).catch(() => {})
        await runCmd('sc',  ['delete', 'MaqueOCR'], {}, () => {}).catch(() => {})

        await runCmd(nssmExe, ['install', 'MaqueOCR', pyExe, AGENT_DEST], {}, onLog)
        await runCmd(nssmExe, ['set', 'MaqueOCR', 'AppDirectory', OCR_DATA_DIR], {}, onLog)
        await runCmd(nssmExe, ['set', 'MaqueOCR', 'Start', 'SERVICE_AUTO_START'], {}, onLog)
        await runCmd(nssmExe, ['set', 'MaqueOCR', 'ObjectName', 'LocalSystem'], {}, onLog)
        await runCmd(nssmExe, ['set', 'MaqueOCR', 'AppEnvironmentExtra',
            `PYTHONPATH=${path.join(PYTHON_DIR, 'Lib', 'site-packages')}`], {}, onLog)
        await runCmd(nssmExe, ['set', 'MaqueOCR', 'AppStdout',
            path.join(OCR_DATA_DIR, 'ocr.log')], {}, onLog)
        await runCmd(nssmExe, ['set', 'MaqueOCR', 'AppStderr',
            path.join(OCR_DATA_DIR, 'ocr-error.log')], {}, onLog)
        await runCmd('net', ['start', 'MaqueOCR'], {}, onLog)
        onLog('MaqueOCR Windows service registered and started.')

    } else if (IS_MAC) {
        const plistPath = '/Library/LaunchDaemons/com.maque.ocr.plist'
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.maque.ocr</string>
    <key>ProgramArguments</key>
    <array>
        <string>${pyExe}</string>
        <string>${AGENT_DEST}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/var/log/maque-ocr.log</string>
    <key>StandardErrorPath</key><string>/var/log/maque-ocr-error.log</string>
</dict>
</plist>`
        fs.writeFileSync(plistPath, plist)
        await runCmd('launchctl', ['unload', plistPath], {}, () => {}).catch(() => {})
        await runCmd('launchctl', ['load', '-w', plistPath], {}, onLog)
        onLog('com.maque.ocr LaunchDaemon registered and started.')
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if OCR runtime is fully installed and ready.
 */
function isOcrInstalled() {
    return fs.existsSync(SENTINEL)
}

/**
 * Full install sequence. Calls onStep / onProgress / onLog as it progresses.
 *
 * @param {string}   appResourcesPath   app.getAppPath() or process.resourcesPath
 * @param {function} onStep    (stepLabel: string, stepIndex: number, total: number) => void
 * @param {function} onProgress (pct: number, detail: string) => void
 * @param {function} onLog     (line: string) => void
 */
async function installOcr(appResourcesPath, onStep, onProgress, onLog) {
    mkdirp(OCR_DATA_DIR)
    const pyExe = IS_WIN ? PY_WIN : PY_MAC
    const steps = IS_WIN ? 4 : 3   // Win needs Python step; Mac uses system Python

    let s = 0

    if (IS_WIN) {
        onStep('下载 Python 运行时', ++s, steps)
        await stepPythonWin(onProgress, onLog)
    }

    onStep('安装 PaddleOCR', ++s, steps)
    await stepPipInstall(pyExe, onProgress, onLog)

    onStep('下载识别模型', ++s, steps)
    await stepDownloadModels(onProgress, onLog)

    onStep('注册后台服务', ++s, steps)
    await stepCopyAgent(appResourcesPath, onLog)
    await stepRegisterService(pyExe, onLog)

    // Write sentinel — marks install as complete
    fs.writeFileSync(SENTINEL, new Date().toISOString())
    onLog('OCR install complete.')
}

module.exports = { isOcrInstalled, installOcr, OCR_DATA_DIR }
