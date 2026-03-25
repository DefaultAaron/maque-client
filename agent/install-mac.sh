#!/bin/bash
# Maque OMS Agent Installer — macOS
# Run as: sudo bash install-mac.sh

set -e

AGENT_DIR="/opt/maque-agent"
PLIST="/Library/LaunchDaemons/com.maque.agent.plist"
NODE_BIN=$(which node)

echo "Installing Maque OMS Agent..."

# Copy agent files
mkdir -p "$AGENT_DIR"
cp "$(dirname "$0")/index.js" "$AGENT_DIR/index.js"

# Copy WireGuard binaries
mkdir -p "$AGENT_DIR/wg"
cp /opt/homebrew/bin/wg           "$AGENT_DIR/wg/wg"
cp /opt/homebrew/bin/wg-quick     "$AGENT_DIR/wg/wg-quick"
cp /opt/homebrew/bin/wireguard-go "$AGENT_DIR/wg/wireguard-go"
chmod +x "$AGENT_DIR/wg/"*

# Note: index.js already hardcodes /opt/maque-agent/wg/ paths — no sed needed.
# The sed patch was removed: it modified the installed copy using fragile string
# replacement and was only needed if paths differed, which they don't here.

# Write launchd plist
cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.maque.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${AGENT_DIR}/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/maque-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/maque-agent-error.log</string>
</dict>
</plist>
PLIST

# Load the service
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "✓ Maque OMS Agent installed and running"
echo "  Logs: /var/log/maque-agent.log"