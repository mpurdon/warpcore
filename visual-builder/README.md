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
- Rust and Cargo (for Tauri v2)
- Python 3.11+ with `warpcore` CLI installed

## Installation

```bash
cd visual-builder
npm install
```

## Development

Run the development server:

```bash
# 1. build the CLI sidecar (once, or after changing the Python CLI)
python packaging/build.py --sidecar   # from the repo root; `python3` on macOS/Linux

# 2. run the app
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

### From an account to a project

Explore Account scans what is actually deployed. **Create project…** in the
Explorer turns that scan into a project on the canvas:

1. **Scope**: pick regions, then include and exclude resources with globs
   (`AWS::Lambda::*`, `name:orders-*`, `tag:Project=shop`; prefix `type:`,
   `name:`, `tag:` or `region:` to pin a field, `*` is everything). A live
   preview shows what the patterns select and which types have no canvas
   node yet. The organisation baseline is left out by default.
2. **Environment**: the account becomes one environment of the project. Pick
   its key and name and which settings it inherits - a built-in template
   (Development, Staging, Production) or an environment of the open project.
3. **Options**: Lambda functions as deployable agents or plain Lambda nodes;
   whether to copy environment variable values (redacted by default); whether
   to register the resources in deployment state so Deploy updates them rather
   than creating duplicates (local state only, on by default).

One fresh scan with full detail runs, then `warpcore.yaml` is written and
opened. Every selected resource is drawn: the serverless types and the
account's infrastructure (EC2 instances, subnets, gateways, route tables,
volumes, load balancers, CloudFront, Route 53, KMS keys, certificates,
instance profiles, RDS and more) each have a node, and any other type becomes
a generic box carrying its AWS type. Nodes are marked deployed and carry their
ARN and region; edges come from execution roles and instance profiles,
environment variables that name another resource, event source mappings, rule
targets, SNS subscriptions, dead-letter queues, VPC and subnet membership,
security-group trust, volume attachments, CloudFront origins and certificates,
"encrypted with" key references and Step Functions definitions. See
`DESIGN_GUIDANCE.md` §9 for how the picture is meant to grow from here:
containment, security-group reachability, a secrets vault with read/write
arrows, and edge layers. The same thing from the CLI:

```bash
warpcore --profile prod discover project --project-name shop --env prod \
  --region us-east-1 --include 'AWS::Lambda::*' --include type:dynamodb --adopt --json
```

### Reading the canvas of an imported account

- **VPCs and subnets are containers.** What runs in a subnet sits inside it;
  VPC-level things (gateways, route tables, endpoints, security groups) sit
  in a strip along the top of the VPC.
- **Security groups are badges** on their members. Click a badge to inspect
  the group: its inbound rules and members. A default group that admits
  traffic from anywhere and has members is flagged, and the inspector says why.
- **Everything outside a VPC sits in a group by role**: Edge & DNS
  (CloudFront, Route 53, certificates, APIs), Messaging & Events, Compute,
  Data & Storage, Secrets, Keys, Configuration, Identity, Observability, and
  Other for types with no node of their own. Groups are laid out left to
  right in the order things happen. Arrows between members come from IAM
  policy documents and say read, write, read/write or admin, and via which
  role.
- **Layers** (top right of the canvas) show or hide triggers, access,
  network, encryption and plumbing edges. Selecting a node shows all of its
  edges regardless, dimmed for layers that are off.
- **Volumes, snapshots, Lambda versions** and the like are folded into their
  parent: a paperclip count on the node, and an "Attached" section in the
  inspector.

### The project lock

Every project opens **locked**, and locks again whenever you switch
environments or open another project. Locked means view-only: select and
inspect anything, but the palette, drag, delete, connect, the configuration
form, the environment settings, Deploy and Destroy are all off. The toolbar
shows an amber **Locked** button and the canvas a banner; both open the unlock
dialog, which asks you to type the project's name. Click **Unlocked · env** in
the toolbar to lock again.

### The inspector

The right-hand panel shows whatever is selected and never takes you away
from the canvas:

- **Nothing selected**: the project - environments, resource counts, cost
  estimate, last deployment, and the Roles tab.
- **A node**: its configuration summary, connections (click one to jump to
  it), cost, the execution log after a deploy, and the raw node as JSON.
- **An environment**: open one from the environment dropdown in the toolbar.
  Removal policies, log retention, X-Ray and Lambda defaults are edited here
  and written to `warpcore.yaml` under `environments.<env>` on save, so they
  are shared with everyone on the project.

### Settings

The gear at the bottom of the left rail (or `Cmd/Ctrl + ,`) opens
application settings. These are about this machine and this operator and are
never written to `warpcore.yaml`:

| Section | What it holds |
|---|---|
| General | Developer mode (`--dev`), CLI log level, reset |
| Regions | Regions of interest, offered everywhere else in the app |
| Exploration | Default AWS profile, how long a scan is reused, scan parallelism, scan cache |
| Logs | The CLI's daily JSONL logs, per project and home, with a viewer |
| Audit trail | Every AWS change the CLI made, per environment |
| Dev sessions | Manifests captured in developer mode |
| Storage | Everything under `.warpcore`, with sizes and clear actions |
| Projects | Recent projects and the directory Open starts in |
| About | App, CLI sidecar and platform versions |

The CLI writes beside the open project's `warpcore.yaml` when there is one,
and under `~/.warpcore` otherwise; the Logs, Audit and Storage sections show
both. See `DESIGN_GUIDANCE.md` for why settings are split this way.

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
- `Cmd/Ctrl + ,`: Application settings (`Esc` returns to the canvas)
- `Delete`: Delete selected nodes/edges
- `Cmd/Ctrl + Z`: Undo
- `Cmd/Ctrl + Shift + Z`: Redo

## The warpcore sidecar

The app does not call a `warpcore` on your PATH. It bundles the CLI as a Tauri
**sidecar** - `src-tauri/binaries/warpcore-<target-triple>` - which Tauri ships
inside the `.app`/`.msi` and places next to the app binary at runtime.

This means the GUI always runs the CLI it was built against. Before this, a
user with an older `warpcore` on PATH would get errors like
`No such option: --dev` from the debug toggle, and on Windows the CLI often
would not resolve at all, because Python console scripts install into
`Scripts\` which is not reliably on PATH.

Build it from the repo root:

```bash
python packaging/build.py --sidecar
```

**`tauri dev` and `tauri build` both fail if the sidecar is missing** - Tauri
validates `bundle.externalBin` at build time. If you see
`failed to run custom build command`, that is usually the cause.

The sidecar is gitignored (it is a 35MB build artifact) and PyInstaller does
not cross-compile, so each platform you ship needs its own build.

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

The file watcher runs entirely in Rust (`watch_config_file` in `src-tauri/src/main.rs`)
using `std::fs`, so it is not permission-gated - Tauri capabilities only restrict what
the *frontend* may call. If watching fails, the path is wrong or unreadable by the
user running the app.

## Contributing

Contributions are welcome! Please see the main project README for contribution guidelines.

## License

See the main project LICENSE file.
