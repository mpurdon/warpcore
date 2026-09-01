#!/bin/bash
set -e

echo "=========================================="
echo "Warpcore Global Installation"
echo "=========================================="
echo ""
echo "Choose installation method:"
echo ""
echo "1) uv tool (Recommended - Isolated, fast)"
echo "2) pipx (Good - Isolated)"
echo "3) pip --user (System-wide for your user)"
echo "4) Cancel"
echo ""
read -p "Enter choice [1-4]: " choice

case $choice in
    1)
        echo ""
        echo "Installing with uv tool..."
        if ! command -v uv &> /dev/null; then
            echo "uv not found. Installing uv first..."
            curl -LsSf https://astral.sh/uv/install.sh | sh
            export PATH="$HOME/.cargo/bin:$PATH"
        fi
        
        uv tool install .
        
        echo ""
        echo "✅ Installation complete!"
        echo ""
        echo "Warpcore is now available globally:"
        echo "  warpcore --help"
        echo ""
        echo "To update:"
        echo "  cd $(pwd) && uv tool install --reinstall ."
        echo ""
        echo "To uninstall:"
        echo "  uv tool uninstall warpcore"
        ;;
        
    2)
        echo ""
        echo "Installing with pipx..."
        if ! command -v pipx &> /dev/null; then
            echo "pipx not found. Installing pipx first..."
            if command -v uv &> /dev/null; then
                uv tool install pipx
            elif command -v brew &> /dev/null; then
                brew install pipx
            else
                python3 -m pip install --user pipx
            fi
            python3 -m pipx ensurepath
        fi
        
        pipx install .
        
        echo ""
        echo "✅ Installation complete!"
        echo ""
        echo "Warpcore is now available globally:"
        echo "  warpcore --help"
        echo ""
        echo "To update:"
        echo "  cd $(pwd) && pipx install --force ."
        echo ""
        echo "To uninstall:"
        echo "  pipx uninstall warpcore"
        ;;
        
    3)
        echo ""
        echo "Installing with pip --user..."
        python3 -m pip install --user .
        
        echo ""
        echo "✅ Installation complete!"
        echo ""
        echo "Make sure ~/.local/bin is in your PATH:"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
        echo "Add to your ~/.zshrc or ~/.bashrc:"
        echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
        echo ""
        echo "Then run:"
        echo "  warpcore --help"
        echo ""
        echo "To update:"
        echo "  cd $(pwd) && pip install --user --upgrade ."
        echo ""
        echo "To uninstall:"
        echo "  pip uninstall warpcore"
        ;;
        
    4)
        echo "Installation cancelled."
        exit 0
        ;;
        
    *)
        echo "Invalid choice. Installation cancelled."
        exit 1
        ;;
esac

echo ""
echo "=========================================="
echo "Testing installation..."
echo "=========================================="
echo ""

if command -v warpcore &> /dev/null; then
    warpcore --help | head -20
    echo ""
    echo "✅ Warpcore is working!"
else
    echo "⚠️  Warning: 'warpcore' command not found in PATH"
    echo ""
    echo "You may need to:"
    echo "1. Restart your terminal"
    echo "2. Add the installation directory to PATH"
    echo "3. Run: source ~/.zshrc (or ~/.bashrc)"
fi
