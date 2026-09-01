# Installing Warpcore Globally

## ✅ Quick Install (Recommended)

From the warpcore source directory:

```bash
uv tool install .
```

That's it! Now `warpcore` is available globally from any directory.

## Verify Installation

```bash
which warpcore
# Output: /Users/yourusername/.local/bin/warpcore

warpcore --help
# Shows help text

# Test from any directory
cd ~
warpcore init --help
```

## Installation Methods Comparison

### 1. uv tool (Recommended) ⭐

**Pros:**
- Isolated environment (no conflicts)
- Fast installation (~1 second)
- Easy to update
- Automatic PATH management

**Install:**
```bash
uv tool install .
```

**Update:**
```bash
cd /path/to/warpcore
uv tool install --reinstall --force .
```

**Uninstall:**
```bash
uv tool uninstall warpcore
```

**Location:** `~/.local/bin/warpcore`

---

### 2. pipx (Also Good)

**Pros:**
- Isolated environment
- Widely used
- Similar to uv tool

**Install:**
```bash
# Install pipx first if needed
brew install pipx
# or: pip install --user pipx

# Install warpcore
pipx install .
```

**Update:**
```bash
cd /path/to/warpcore
pipx install --force .
```

**Uninstall:**
```bash
pipx uninstall warpcore
```

---

### 3. pip --user

**Pros:**
- No extra tools needed
- Works everywhere

**Cons:**
- Can have dependency conflicts
- Harder to manage

**Install:**
```bash
pip install --user .

# Add to PATH if needed
export PATH="$HOME/.local/bin:$PATH"
```

**Update:**
```bash
cd /path/to/warpcore
pip install --user --upgrade --force-reinstall .
```

**Uninstall:**
```bash
pip uninstall warpcore
```

---

## Using the Install Script

We've provided an interactive installer:

```bash
./install-global.sh
```

This will guide you through the installation process.

---

## After Installation

### Test It Works

```bash
# Check installation
which warpcore
warpcore --help

# Create a test project
mkdir ~/test-warpcore && cd ~/test-warpcore
warpcore init
```

### Use It Anywhere

```bash
# Go to your agents project
cd ~/my-strands-agents

# Initialize
warpcore init

# Deploy
warpcore deploy --env dev
```

---

## Updating Warpcore

When you make changes to the warpcore source:

```bash
cd /path/to/warpcore

# Pull latest changes
git pull

# Reinstall globally
uv tool install --reinstall --force .
```

---

## Troubleshooting

### Command not found: warpcore

**Check PATH:**
```bash
echo $PATH | grep -o "$HOME/.local/bin"
```

If not found, add to your shell config:

```bash
# For zsh (macOS default)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# For bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### Module not found errors

Reinstall with force:
```bash
uv tool install --reinstall --force .
```

### Permission errors

Don't use `sudo`! Use `uv tool install` or `pip install --user` instead.

---

## Development vs Global Install

You can have both:

1. **Global install** - For using warpcore with your agents
   ```bash
   uv tool install .
   ```

2. **Development install** - For developing warpcore itself
   ```bash
   uv sync --all-extras
   uv run pytest
   ```

They don't conflict! The global install is isolated.

---

## Comparison Table

| Method | Speed | Isolated | Easy Update | Recommended |
|--------|-------|----------|-------------|-------------|
| `uv tool` | ⚡️ Fast | ✅ Yes | ✅ Yes | ⭐ Best |
| `pipx` | 🟡 Medium | ✅ Yes | ✅ Yes | 👍 Good |
| `pip --user` | 🟡 Medium | ❌ No | 🟡 OK | 🤷 OK |
| `pip` (sudo) | 🟡 Medium | ❌ No | ❌ No | ❌ Avoid |

---

## What Gets Installed

When you run `uv tool install .`:

1. Creates isolated environment at `~/.local/share/uv/tools/warpcore/`
2. Installs warpcore and all dependencies
3. Creates executable at `~/.local/bin/warpcore`
4. Adds to PATH automatically

**Size:** ~50MB (includes all dependencies)

---

## Uninstalling

```bash
# With uv tool
uv tool uninstall warpcore

# With pipx
pipx uninstall warpcore

# With pip
pip uninstall warpcore
```

---

## Summary

**For most users:**
```bash
uv tool install .
```

**Then use anywhere:**
```bash
cd ~/my-agents
warpcore init
warpcore deploy --env dev
```

**To update:**
```bash
cd /path/to/warpcore
git pull
uv tool install --reinstall --force .
```

That's it! 🚀
