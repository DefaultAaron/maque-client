#!/bin/bash
# Run from maque-client root on your dev Mac.
# Prepares the small set of resources bundled inside the installer.
# Python, PaddleOCR, and OCR models are downloaded by the app at first launch
# — they are NOT bundled here (keeps installer under ~150MB).
set -e

mkdir -p resources/win resources/node

# ── 1. NSSM ──────────────────────────────────────────────────────────────────
echo "1. Downloading NSSM..."
curl -sL "https://github.com/kirillkovalenko/nssm/releases/download/2.24-101-g897c7ad/nssm-2.24-101-g897c7ad.zip" \
    -o /tmp/nssm.zip 2>/dev/null || \
curl -sL "https://www.nssm.cc/ci/nssm-2.24-103-gdee49fc.zip" \
    -o /tmp/nssm.zip

if unzip -t /tmp/nssm.zip &>/dev/null; then
    unzip -o -j /tmp/nssm.zip "*/win64/nssm.exe" -d resources/win/ 2>/dev/null || \
    unzip -o -j /tmp/nssm.zip "*/nssm.exe"       -d resources/win/
else
    curl -sL "https://nssm.cc/release/nssm-2.24.zip" --retry 3 -o /tmp/nssm.zip
    unzip -o -j /tmp/nssm.zip "*/win64/nssm.exe" -d resources/win/
fi
echo "   ✓ resources/win/nssm.exe"

# ── 2. Node.js for VPN agent ─────────────────────────────────────────────────
echo "2. Downloading Node.js for Windows..."
NODE_VER="v20.11.0"
curl -L "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-win-x64.zip" \
    -o /tmp/node-win.zip --progress-bar
unzip -o /tmp/node-win.zip "node-${NODE_VER}-win-x64/node.exe" -d /tmp/
cp /tmp/node-${NODE_VER}-win-x64/node.exe resources/node/node.exe
echo "   ✓ resources/node/node.exe"

# ── 3. WireGuard binaries (manual — still required) ──────────────────────────
echo ""
echo "3. WireGuard binaries — MANUAL STEP:"
echo "   On a Windows machine with WireGuard installed:"
echo "     C:\\Program Files\\WireGuard\\wireguard.exe  →  agent/wg/wireguard.exe"
echo "     C:\\Program Files\\WireGuard\\wg.exe         →  agent/wg/wg.exe"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Done. Complete step 3, then: npm run build:win"
echo "  Installer size: ~150MB (Python/OCR models download at first use)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"