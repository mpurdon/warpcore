#!/bin/bash
set -e

echo "🚀 Building Warpcore Visual Builder..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    echo "❌ Rust is not installed. Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build the application
echo "🔨 Building application (this may take a few minutes)..."
npm run tauri:build

# Find the built app
APP_PATH="src-tauri/target/release/bundle/macos/Warpcore Visual Builder.app"

if [ ! -d "$APP_PATH" ]; then
    echo "❌ Build failed - app not found at: $APP_PATH"
    exit 1
fi

# Install to Applications folder
echo "📲 Installing to /Applications..."
rm -rf "/Applications/Warpcore Visual Builder.app"
cp -r "$APP_PATH" /Applications/

# Create CLI launcher
echo "🔗 Creating CLI launcher..."
sudo ln -sf "/Applications/Warpcore Visual Builder.app/Contents/MacOS/Warpcore Visual Builder" /usr/local/bin/warpcore-ui

echo ""
echo "✅ Installation complete!"
echo ""
echo "You can now:"
echo "  1. Open 'Warpcore Visual Builder' from your Applications folder"
echo "  2. Run from Spotlight: Cmd+Space, type 'Warpcore Visual Builder'"
echo "  3. Launch from terminal: warpcore-ui"
echo "  4. Or run: open -a 'Warpcore Visual Builder'"
echo ""
echo "The visual builder provides:"
echo "  • Drag-and-drop infrastructure design"
echo "  • Real-time deployment monitoring"
echo "  • Visual node editor (N8N-style)"
echo "  • Bidirectional sync with warpcore.yaml"
