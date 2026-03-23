#!/bin/bash
# Run from maque-client root directory
set -e
mkdir -p resources/win resources/node

echo "1. Downloading NSSM..."
# Use GitHub mirror instead
curl -sL "https://github.com/kirillkovalenko/nssm/releases/download/2.24-101-g897c7ad/nssm-2.24-101-g897c7ad.zip" \
    -o /tmp/nssm.zip 2>/dev/null || \
curl -sL "https://www.nssm.cc/ci/nssm-2.24-103-gdee49fc.zip" \
    -o /tmp/nssm.zip

if unzip -t /tmp/nssm.zip &>/dev/null; then
    unzip -o -j /tmp/nssm.zip "*/win64/nssm.exe" -d resources/ 2>/dev/null || \
    unzip -o -j /tmp/nssm.zip "*/nssm.exe" -d resources/
    echo "   ✓ resources/nssm.exe"
else
    echo "   NSSM download failed - downloading pre-built binary directly..."
    curl -sL "https://nssm.cc/release/nssm-2.24.zip" --retry 3 -o /tmp/nssm.zip
    unzip -o -j /tmp/nssm.zip "*/win64/nssm.exe" -d resources/
    echo "   ✓ resources/nssm.exe"
fi

echo "2. Downloading Node.js for Windows..."
curl -L "https://nodejs.org/dist/v20.11.0/node-v20.11.0-win-x64.zip" \
    -o /tmp/node-win.zip --progress-bar
unzip -o /tmp/node-win.zip "node-v20.11.0-win-x64/node.exe" -d /tmp/
cp /tmp/node-v20.11.0-win-x64/node.exe resources/node/node.exe
echo "   ✓ resources/node/node.exe"

echo ""
echo "3. WireGuard binaries (manual):"
echo "   On Windows: install WireGuard from https://wireguard.com/install/"
echo "   Copy to this Mac:"
echo "   C:\\Program Files\\WireGuard\\wireguard.exe → resources/win/wireguard.exe"
echo "   C:\\Program Files\\WireGuard\\wg.exe        → resources/win/wg.exe"
echo ""
echo "✓ Done. Add WireGuard binaries then run: npm run build:win"