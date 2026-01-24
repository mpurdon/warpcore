# Warpcore Visual Infrastructure Builder

A cross-platform desktop application for visually designing, deploying, and monitoring Warpcore AWS infrastructure.

## Features

- **Visual Canvas**: Drag-and-drop interface for designing infrastructure
- **Node-Based Editor**: Create agents and AWS resources as visual nodes
- **Connection System**: Draw connections between resources to define permissions
- **Real-Time Deployment**: Watch deployments execute with live status updates
- **Execution Logs**: Detailed logs for each resource with step-by-step progress
- **Deployment Timeline**: Visualize parallel execution and performance
- **Bidirectional Sync**: Automatically sync with `warpcore.yaml` configuration
- **Multi-Environment**: Switch between dev, staging, and production environments

## Quick Install (macOS)

```bash
cd visual-builder
./install-app.sh
```

This will build and install the app to your Applications folder. You can then:
- Open "Warpcore Visual Builder" from Applications
- Or run: `open -a 'Warpcore Visual Builder'`

To create a CLI launcher:
```bash
sudo ln -sf '/Applications/Warpcore Visual Builder.app/Contents/MacOS/warpcore-visual-builder' /usr/local/bin/warpcore-ui
```

Then launch with: `warpcore-ui`

## Prerequisites

- Node.js 18+ and npm
- Rust and Cargo (for Tauri)
- Python 3.11+ with `warpcore` CLI installed

## Installation

```bash
cd visual-builder
npm install
```

## Development

Run the development server:

```bash
npm run tauri:dev
```

This will start both the Vite dev server and the Tauri application.

## Building

Build the application for your platform:

```bash
npm run tauri:build
```

The built application will be in `src-tauri/target/release/`.

## Project Structure

```
visual-builder/
├── src/
│   ├── components/
│   │   ├── nodes/          # Custom node components
│   │   ├── edges/          # Custom edge components
│   │   ├── Toolbar.tsx     # Top toolbar with actions
│   │   ├── ResourceLibrary.tsx  # Left sidebar with resources
│   │   ├── ExecutionLogPanel.tsx  # Right panel for logs
│   │   └── DeploymentTimeline.tsx  # Bottom timeline
│   ├── store/
│   │   └── useStore.ts     # Zustand state management
│   ├── utils/
│   │   └── configSync.ts   # YAML ↔ Canvas sync
│   ├── App.tsx             # Main application
│   └── main.tsx            # Entry point
├── src-tauri/
│   ├── src/
│   │   └── main.rs         # Tauri backend (Rust)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

## Usage

### Creating Infrastructure

1. **Drag Resources**: Drag resources from the left sidebar onto the canvas
2. **Connect Resources**: Click and drag from one node to another to create connections
3. **Configure**: Click nodes to edit their properties
4. **Save**: Click "Save" to generate `warpcore.yaml`
5. **Deploy**: Click "Deploy" to deploy to AWS

### Monitoring Deployments

1. **Real-Time Status**: Nodes change color based on deployment status:
   - 🔵 Blue (pulsing): Deploying
   - 🟢 Green (glow): Success
   - 🔴 Red (glow): Failed
   - 🟡 Yellow (glow): Warning
   - ⚪ Gray (dim): Pending

2. **Execution Logs**: Click any node to see detailed execution logs
3. **Timeline**: View parallel execution timeline at the bottom

### Node Types

- **Agent**: Strands SDK agent (Lambda function)
- **S3 Bucket**: Object storage
- **DynamoDB Table**: NoSQL database
- **SQS Queue**: Message queue
- **SNS Topic**: Pub/sub messaging
- **API Gateway**: HTTP API
- **IAM Role**: Identity and access management
- **Security Group**: Network security
- **VPC**: Virtual private cloud

### Connection Types

- **Permission Edge**: Defines IAM permissions from agent to resource
  - Click edge to edit permissions
  - Choose from templates (Read, Write, Full Access)
  - Or define custom IAM actions

## Integration with CLI

The Visual Builder integrates seamlessly with the Warpcore CLI:

- **Reads/Writes**: Same `warpcore.yaml` configuration file
- **Executes**: Uses CLI commands for deployment
- **Monitors**: Streams CLI output in real-time
- **Compatible**: Can use CLI in CI/CD, Visual Builder for development

## Keyboard Shortcuts

- `Cmd/Ctrl + S`: Save configuration
- `Cmd/Ctrl + O`: Open configuration
- `Cmd/Ctrl + D`: Deploy
- `Delete`: Delete selected nodes/edges
- `Cmd/Ctrl + Z`: Undo
- `Cmd/Ctrl + Shift + Z`: Redo

## Troubleshooting

### Tauri Build Fails

Make sure you have Rust installed:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### CLI Commands Not Working

Ensure the `warpcore` CLI is installed and in your PATH:
```bash
which warpcore
```

### File Watching Not Working

The file watcher requires file system permissions. Check Tauri's `tauri.conf.json` for the `fs` allowlist.

## Contributing

Contributions are welcome! Please see the main project README for contribution guidelines.

## License

See the main project LICENSE file.
