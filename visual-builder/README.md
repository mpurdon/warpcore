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

### Deploying, and watching it happen

Deploy runs `warpcore deploy --env <env> --progress` through the bundled CLI
and nothing else: there is no simulation. The CLI streams one JSON event per
line (a `plan` naming every resource it will touch, a `resource` event as each
one starts and finishes, a `complete` event with the outcome) and the
**Activity** drawer along the bottom of the canvas shows exactly that: each
planned resource with its real start and end, any error, and the raw CLI
output on a second tab. Nodes take their status from the same events:

- 🔵 Ready / deploying (pulsing) · 🟢 Deployed · 🔴 Failed · ⚪ Not configured

An empty plan is reported as an empty plan. Until the orchestrator builds
resources from the configuration (`UX_PLAN.md` §3, step 0) that is what a
deploy of a fresh project shows.

Destroy asks first, then runs `warpcore destroy --progress -y` the same way.

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

An account is drawn as **one tile per application**, and a tile reads top
to bottom the way a request does:

| Band | Holds |
|---|---|
| **Entry** | Route 53 zones, CloudFront, certificates, API Gateway, load balancers |
| **Compute** | Agents, Lambda, Step Functions, ECS, and the VPC with its subnets drawn inside this band |
| **Bus** | Queues, topics, streams, event rules |
| **Data** | Buckets, tables, databases, caches, registries |
| **Platform** | Roles, instance profiles, secrets, keys, parameters, log groups, alarms, as compact chips |

Width is bounded (four cells, or the widest VPC); bands wrap their contents
and only appear when they have members. A tile with a single band holds its
members directly, so an application that is one VPC is drawn as that VPC.
A monorepo account gives one tile per application plus a *Shared platform*
tile for what more than one application uses.

- **Which application a resource belongs to** is decided by tags
  (`Application`, `Service`, `Project`, `app`, ...), then by a name prefix
  shared by three or more resources or matching the project name (past an
  environment token, so `dev-talend-vpc` is talend's), then by the wiring:
  an untagged resource joins the application it is connected to. A VPC with
  nothing running in it is platform, not an application. The inspector's
  *Application* section says which rule placed it.
- **VPCs and subnets are containers.** What runs in a subnet sits inside it;
  the VPC's own plumbing (gateways, route tables, endpoints) is a strip of
  chips along the top, wrapped to the width of the subnets.
- **Security groups are badges** on their members, never cards. Click a
  badge to inspect the group: its inbound rules and members. Trust between
  groups is drawn between their members on the network layer ("allowed
  inbound via bastion-sg"). A default group that admits traffic from
  anywhere and has members is flagged, and the inspector says why.
- **Layers** default to traffic and access. An account whose relationships
  are all on other layers (a plain VPC) opens with those layers switched on,
  so there is always a picture.
- **Lenses** (top left of the canvas, or keys `1`-`5`) view the tile through
  one question. On an imported account a lens *removes* what it is not
  about: the nodes go, a band with nothing left goes with them, and the
  tile re-flows. Each band and the tile carry an *n hidden* pill; click it
  (or press `1`) to show everything again. *Security* keeps security
  groups, roles, secrets, keys and anything flagged; *Network* the VPC,
  gateways, load balancers and what sits inside them; *Data flow* agents,
  functions, queues, topics, streams and stores; *Cost* draws each node's
  monthly estimate on it. On a hand-drawn canvas a lens dims instead, since
  there positions carry meaning. **Edges** beside the lens bar are the expert
  control over which edge kinds are drawn.
- Arrows between members come from IAM policy documents and say read,
  write, read/write or admin, and via which role.
- **Volumes, snapshots, Lambda versions** and the like are folded into their
  parent: a paperclip count on the node, and an "Attached" section in the
  inspector.

### Live: what a resource is doing right now

Every imported card has a **Live** tab in the inspector, beside Overview,
Execution and Raw. Opening the tab is the request: it reads then, not on
selection, because each read is a handful of AWS calls (`warpcore discover
detail`), and is cached per window once read.

- **Now beside then.** The service's current state next to the state the
  import recorded, so a host that has stopped since shows as drift without
  a re-import.
- **Headline metrics.** A strip of sparkline tiles for the two to four
  metrics that say how busy the thing is: CPU and network for an instance,
  bytes and connections for a NAT gateway, invocations, errors and duration
  for a function, connections and free storage for a database.
- **The Explorer's tabs.** Overview, network (placement, rules with the
  world-open ones in red, routes, flow logs), metrics with sparklines, logs,
  related. The same component the Account Explorer's drawer uses.

The profile these calls use is the one recorded on the environment block by
the import; a project imported before that was recorded falls back to the
default profile in Settings.

### Connect: how to reach an instance

An instance's inspector has a **Connect** section. *How do I reach this?*
runs `warpcore discover connect`, which checks what reaching the instance
from this machine needs and shows each check with a tick or a cross:
running; Session Manager (an instance profile, and the agent online); the
key pair on this machine, with the places it looked; the port open to this
machine's address; and, when there is no public address, a jump host among
the instances the security groups admit.

Two more checks cover what is easy to miss: whether the Session Manager
plugin the AWS CLI shells out to is on this machine, and whether the
instance's VPC has an EC2 Instance Connect Endpoint, which reaches a private
instance with no bastion and no public address. When the account's session
preferences set an idle timeout, the notes say how long a session lasts.

It then composes the command that would work: Session Manager first, then
SSH, then the Instance Connect Endpoint, then SSH through the bastion as a
`ProxyCommand`. **Copy** puts it on
the clipboard; **Open in Terminal** recomputes it in the backend from the
ARN and opens it in a terminal window, so the page never hands a shell
string across. When a check fails, the notes say what would fix it.

### Review: what is wrong, wasteful or fragile

**Review** in the toolbar runs `warpcore discover findings` over the open
project: every metered resource's CloudWatch metrics over a window, then
the rules. Idle hosts (CPU under 5% peak and 2% average), NAT gateways that
carried almost nothing, ports open to the world weighed against the traffic
that actually arrived, stopped instances still billing their volumes, no
instance profile for Session Manager, IMDSv1, old snapshots, log groups that
never expire, failing or throttled functions, databases nobody connects to.

Every finding carries its evidence and a suggestion. The drawer lists them
by severity and kind; click one and the canvas selects the resource. Cards
the review names wear a count badge coloured by their worst finding, and
the inspector's **Findings** section shows each one with its evidence.

### The assistant

A model is optional and never in the path that builds the picture. Choose a
provider in Settings › Exploration › Assistant (Anthropic, OpenAI, Bedrock
or a local model); credentials come from the environment the CLI runs in
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, AWS for Bedrock) and the app stores
none. The Anthropic SDK is an optional extra: `pip install "warpcore[ai]"`.

With one configured, three things happen, each checked by the deterministic
side:

- **Review** hands the findings and the canvas to the model, which ranks
  them for this account and writes one or two sentences on why each matters
  here, with a numbered chain of the evidence it reasoned from so every
  step can be checked against the finding's own evidence. It cannot add or
  drop a finding; if it fails, the rules' order stands.
- **Import** asks the model to name application tiles whose every member was
  placed by a guess (a component named after its busiest member or an AWS
  id). The inspector says *named by the assistant* and why.
- **Draft with assistant**, in a project's Scenarios section or an empty
  scenario, asks for a scenario over the graph and the hops the checker
  allows. The draft is added like any other scenario and every hop the
  wiring cannot ground shows as a problem.

### The Live lens: the account's word on every card

The lens bar's sixth lens, **Live** (key `6`), colours every discovered card
by what the account says now, worsened by the last review: green for
running and clean, amber for stopped or a medium or high finding, red for
gone, dotted grey for not checked. Choosing the lens reads the account
(`warpcore discover health`, batched describes) and the bar says when it
was read and how many are bad, warn and ok; after fifteen minutes the
outlines go dashed until **refresh** reads again. Nothing here writes.

### Drift: the deployment state against the account

The Review drawer opens with a **Drift** row. **Check** runs
`warpcore discover drift`, which reads every resource the deployment state
records and compares only the properties the record set, so an AWS default
is never drift. What changed behind warpcore's back is listed with the
recorded and live values; what is gone is listed as gone; click a row and
the canvas selects the card. In the Live lens those cards wear a violet
(changed) or dashed red (gone) outline. Settings › Exploration › Drift can
schedule the check every 15 minutes, hour or 4 hours while the project is
open.

### Since last import

Every import keeps a snapshot of what it saw under
`.warpcore/snapshots/<time>.json` beside the project file. When a project is
opened after a second import, the project inspector's **Since last import**
section lists what appeared, what went, which properties changed and which
connections came or went. `warpcore discover snapshots --config …` prints
the same.

### What if

A scenario's inspector has a **What if** section: pick a resource on its
path and the same checker runs over the wiring without it, naming the steps
that lose their evidence. The Activity drawer does the same for a deploy
plan: when the plan deletes something a scenario passes through, the drawer
says which scenarios break before anything is applied.

### Light and dark

Settings › General › Appearance chooses light, dark, or whatever the
system is set to; `⌘K` → "Appearance" switches it too. Both themes are
designed on purpose: see `DESIGN_GUIDANCE.md` §17 for how the dark palette
is built and the rules for adding a colour. After changing
`scripts/build-theme.mjs`, run `node scripts/build-theme.mjs` and restart
`tauri dev` (Tailwind keeps its config in memory).

### The command layer

Everything the app can do is a command (`src/commands/`), declared once:
the toolbar, the keyboard, the palette, the inspector and an assistant all
run the same commands through one dispatcher, which checks the arguments,
honours the lock, confirms anything that changes AWS or the deployment
state, and writes a receipt. The Activity drawer's **Commands** tab lists
every receipt with where it came from. In a dev build,
`window.__warpcore.commands.list()`, `.run(id, args)` and `.tools()` expose
the registry, so an automated check or an agent can drive the app the way
a person does. See `DESIGN_GUIDANCE.md` §15.

### The assistant panel

**Assistant** in the toolbar (`⌘J`) opens a conversation docked beside
the inspector. Ask about the canvas or ask for a change: the model is
handed the command registry as its tools, so it reads the graph exactly
(`query_path`, `query_reach`, `scenario_check`, …), edits the project
under the same lock as you, and anything that changes AWS or the
deployment state waits for your yes on a card in the panel. Every command
it runs lands as its own line there and in the Activity drawer's
receipts; the model is told not to repeat them. One model turn at a time
goes through `warpcore assistant turn` with the provider chosen in
Settings (Anthropic, OpenAI, Bedrock or a local model); the app stores no
key.

### The project over MCP, and the running app

`warpcore mcp --config warpcore.yaml` serves the project to an editor or
agent over stdio (`pip install "warpcore[mcp]"`): the canvas, each
resource with its edges, the scenarios, live detail, health, the review's
findings, the deploy plan and the connect plan, plus two writes that touch
only the project's own files (mute a finding, add a scenario). Add it to
Claude Code with `claude mcp add warpcore -- warpcore mcp --config
/path/to/warpcore.yaml`; `--list` prints the tools.

While the Visual Builder is running, its commands are tools too. The app
opens a loopback door when it starts and records the port and a token in
`~/.warpcore/app.json`; `warpcore mcp` finds it and publishes every
command (`query_project`, `canvas_addNode`, `view_select`,
`account_deploy`, …) alongside the file tools. An agent then acts on the
canvas as the operator sees it, through the same dispatcher, with the same
receipts, and a change to AWS waits on the same card in the assistant
panel for the operator's yes.

### Scenarios: play a request through the system

A **scenario** is a named event played step by step through the resources
it touches: "a webhook arrives" lights the API, then the authorizer, then
the key it decrypts with, then the function, then the table, while the log
groups tick. Scenarios live in `warpcore.yaml` under `scenarios:`, so they
are shared and reviewed with the project:

```yaml
scenarios:
  - name: Webhook received
    trigger: { at: api-gateway-gitf-api, event: POST /webhook }
    steps:
      - at: lambda-gitf-authorizer   # validates the signature
        takes: 40ms
      - at: kms-key-gitf-key
      - at: lambda-gitf
        takes: 180ms
      - at: dynamodb-gitf-sessions
        note: writes the session row
      - at: sns-gitf-events
        detached: true               # fire and forget
```

- **Make one** from the project inspector (*New scenario*), from a node's
  inspector (*Start a scenario here*), or the palette. Then press
  **Record** and click resources on the canvas in order, or pick from the
  hops the graph offers next, or **Suggest a path** to let the graph draft
  the steps from the trigger. Steps can be reordered, annotated, timed and
  marked *detached* in the inspector. Editing respects the lock; playing
  does not.
- **Play** puts a transport bar over the canvas: play, pause, step, jump to
  a step, speed. The request travels each hop as a comet (a bright bead
  with a fading tail, on a hop lit end to end), the resource it lands on
  flashes a ring and glows, what the scenario does not touch steps back, and every
  compute step's log group lights and ticks with synthetic lines in the
  inspector. The lines show data moving; they are not what the code logs.
  `Space` plays and pauses, `[` and `]` step, `Esc` stops.
- **Every hop is checked** against the wiring on the canvas: invocations,
  event sources and targets, and the access arrows from IAM policies. A
  step with nothing behind it is flagged *no permission or trigger found*,
  and so is a function with no log group. A scenario that passes is a
  statement about the system: this request can happen, and here is the
  policy that lets it.
- Log groups are never steps: they are reached through their function.

### The system view

The cube button in the toolbar (or *System view* in the palette) shows the
canvas as terraces in 3D: the entry band is the highest plate, platform the
lowest, resources are cards on their plate, edges are arcs between cards,
and a VPC is a slab on the compute plate with its subnets on top. It is
read only and reads the same store as the canvas, so the lens, the edge
layers, the selection and a playing scenario are the same in both: switch
lenses and plates lift out, click a card and the inspector shows it, press
Play and the request runs down the stairs with the same transport bar.
Drag to orbit, scroll to zoom, right-drag to pan; *Follow* pans with the
request as it plays, *Reset* frames everything again. A hand-drawn canvas
is one sheet with every card on it.

### The Holodeck

A library of systems to walk through and copy, opened from the toolbar,
the welcome screen or `⌘K`. Four families: AWS reference architectures,
systems "in the style of" a well-known company (each citing its public
talk or post, with the year, rendered on AWS and carrying no branding),
system design classics, and warpcore starters. Every entry is authored in
`visual-builder/holodeck/*.yaml` without coordinates and laid out as the
same application stack an imported account gets, and ships with two to
five scenarios, including the unhappy paths: the timeout, the retry into a
dead-letter queue, the conditional write that loses.

**Preview** loads an entry in memory, read only: play its scenarios, switch
lenses, open the system view. Nothing is written, and whatever was open
comes back when the preview closes. **Save a copy** writes a
`warpcore.yaml` of your own and opens it unlocked. The **Mine** tab holds
custom templates saved from the canvas.

Scenario steps can fail: `outcome: fail | timeout` and `retry: n` in the
file, or the controls on each step in the inspector. A failing step pulses
red, each retry replays the hop, the log ticker shows the errors, and a
dead-letter queue edge is a hop the request can take when a step gives up.
A failure nothing catches is a note in the check, not a problem.

Resources carry a note (`meta.note`): a marker on the card and a paragraph
in the inspector, editable when the project is unlocked.

### The project lock

Every project opens **locked**, and locks again whenever you switch
environments or open another project. Locked means view-only: select and
inspect anything, but the palette, drag, delete, connect, the configuration
form, the environment settings, Deploy and Destroy are all off. The toolbar
shows an amber **Locked** button and the canvas a banner; both open the unlock
dialog, which asks you to type the project's name. Click **Unlocked · env** in
the toolbar to lock again.

### Finding anything

`⌘K` opens the command palette. Type part of a resource's name, type, id or
ARN and press Enter: it is selected, the inspector shows it, and the canvas
pans to it. The same box runs every action in the app - deploy, destroy,
open, save, the Holodeck, explore, discover, lenses, layers, settings sections,
fit view, undo, redo - so nothing has to be hunted for.

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
| General | Appearance (light, dark, follow the system), developer mode (`--dev`), CLI log level, reset |
| Regions | Regions of interest, offered everywhere else in the app |
| Exploration | Default AWS profile, the assistant model, the drift check schedule, how long a scan is reused, scan parallelism, scan cache |
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

Press `?` in the app for the full sheet. The ones worth memorising:

| Keys | What |
|---|---|
| `⌘K` | Command palette: find any resource by name, type, id or ARN; run any action |
| `1` `2` `3` `4` `5` | Lens: All · Security · Network · Data flow · Cost |
| `⌘Z` / `⇧⌘Z` | Undo / redo (drags fold into one step; selection is not a step) |
| `⌘S` / `⌘O` | Save now / open a project (changes also auto-save) |
| `⌘D` | Deploy the current environment, when the project is unlocked |
| `⌘0`, `⌘=`, `⌘-` | Fit view, zoom in, zoom out |
| `⌘,` | Application settings |
| `Space`, `[`, `]` | Play or pause, previous and next step, while a scenario is on the transport bar |
| `Esc` | Close what is open, else clear the selection, else stop recording or playback |
| `⌫` | Delete the selection |

`Ctrl` replaces `⌘` on Windows and Linux.

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
