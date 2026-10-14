# Visual Builder Design Guidance

**Status:** Implemented (2026-09-02); see §6 for what each step became
**Derived from:** the control-plane interface research in `~/Projects/gitf/design system guidance.md`
(UniFi, Tailscale, Grafana Drilldown, Firewalla, TrueNAS, Netdata, Proxmox), narrowed to what the
Warpcore Visual Builder is and already does.

---

## 1. Objective

Turn the Visual Builder from "a canvas with a toolbar and some modals" into a control surface for a
Warpcore project, following the UniFi model:

> **See the system. Select anything. Understand its state. Follow its relationships. Ask why.
> Drill into the evidence. Act without losing context.**

This document does three things:

1. Names the objects the Visual Builder operates on.
2. Settles the split between **environment settings** and **application settings**, which is the
   decision that prompted it.
3. Specifies the surfaces that follow from that split, and how to migrate the current code to them.

It is not a visual style guide. Colours, spacing and typography come later and should be designed
once the surfaces are right.

---

## 2. The object model

UniFi's strength is that everything on screen is an object in the system, not a page in an app. The
operator moves **Organization → Site → Network → Switch → Port → Client** without ever feeling like
they changed applications.

Warpcore has an equally real hierarchy. The interface should make it visible and navigable.

```
Workstation (this machine, this operator)
└── Project            warpcore.yaml, a directory on disk
    └── Environment    dev · staging · prod
        ├── Resource   agent, lambda, dynamodb, eventbridge, log group, IAM role, ...
        │   ├── Connection   permission edge to another resource
        │   ├── Deployment   a run that created/updated/deleted it
        │   │   └── Step → API call → error → suggested fix
        │   └── Cost estimate
        └── Deployment history

AWS Account (via Account Explorer)
└── Profile
    └── Region(s) of interest
        └── Discovered resource → config · network · metrics · logs
```

Two consequences fall out immediately:

- **Every level has its own configuration.** Configuration belongs to the object it configures, and
  it should be edited *on* that object, not in a settings screen somewhere else.
- **Scope must always be explicit.** The operator must be able to see, at a glance, which project and
  which environment the canvas, the inspector and the deploy button currently refer to.

---

## 3. What is built today

An honest inventory, so the rest of the document talks about real surfaces.

| Surface | File | Role today | Verdict against the model |
|---|---|---|---|
| Toolbar (dark, top) | `Toolbar.tsx` | Project name, environment selector, file menu, scan / explore / deploy / destroy, toggle right panel | Mixed: it is a scope selector, a file menu and an action bar at once |
| Resource Library (left) | `ResourceLibrary.tsx` | Drag-source accordion of resource types | Good. This is the palette, not navigation |
| Canvas | `App.tsx` + React Flow | The project's resources and permission edges | This is the topology surface. It is already the strongest part of the app |
| Configuration panel | `ConfigurationPanel.tsx` | Form for the selected node | Correct idea: config lives on the object |
| Execution log panel | `ExecutionLogPanel.tsx` | Steps, logs, API calls, error and fixes for the selected node | Already an Overview → Evidence → Raw ladder. Keep it |
| Right panel | `RightPanel.tsx` | Tabs: Roles (real), Environment ("coming soon") | Should become the inspector for non-node objects |
| Environment Configuration | `EnvironmentConfigPanel.tsx` | Modal: removal policies, logging, lambda defaults, **plus** debug mode and regions of interest | Wrong shape (modal) and wrong contents (mixes shared and personal settings) |
| Account Explorer | `AccountExplorerPanel.tsx` | Modal: pick profile, scan, browse discovered resources | Right idea, wrong container. Its tooltip points to a Settings menu that does not exist |
| Project Discovery | `ProjectDiscoveryPanel.tsx` | Modal: scan project for Strands components | Fine as a task dialog |
| Holodeck drawer, File menu, recents | `HolodeckDrawer.tsx`, `FileMenu.tsx`, `recentProjects.ts` | Library of systems to preview and copy (was the template modal) / open / recent projects | Fine |
| Preferences | `preferences.ts` | `debugMode`, `regions` in localStorage | Correctly separated in code, not in the UI |

The code comment in `preferences.ts` already states the principle this document formalises:
environment settings are written to `warpcore.yaml` and shared with the team, whereas "am I
debugging right now" is personal and must never end up in a committed file. The UI currently
contradicts the code.

---

## 4. The two kinds of settings

This is the central decision.

### 4.1 Environment settings

**Definition:** properties of one Environment object in one Project. Written to `warpcore.yaml`.
Shared with everyone who works on the project. Changing them changes what gets deployed.

Today's fields:

- Removal policies (default, per resource type)
- Logging: default retention days, X-Ray
- Lambda defaults: memory, timeout
- DynamoDB backup

**Where they live:** in the **right-hand inspector**, with the Environment as the selected object.
Not in a modal. The environment selector in the toolbar is the scope selector; its "Open
Environment" action selects that environment in the inspector, exactly as clicking a node selects
that node.

This is the UniFi pattern of *configuration associated with the object being configured*: you edit a
switch port on the switch port, and you edit an environment on the environment.

### 4.2 Application settings

**Definition:** properties of this workstation and this operator. Never written to `warpcore.yaml`.
Stored locally. Changing them changes how the tool behaves, never what gets deployed.

Proposed sections, in order:

| Section | Contents | Source of truth today |
|---|---|---|
| **General** | Developer mode (runs the CLI with `--dev`), theme (later), telemetry (if ever) | `preferences.debugMode` |
| **Regions** | Regions of interest, shown with the existing `RegionPicker`. Empty means "use the profile's region", never "no regions" | `preferences.regions` |
| **Exploration** | Default AWS profile, scan cache lifetime, request throttling / concurrency, whether scans are single-region by default | `LAST_PROFILE_KEY` in localStorage; the rest does not exist yet |
| **Logs** | Application log location, current log level, size on disk, open folder, clear | `.warpcore/logs/warpcore-YYYYMMDD.jsonl` via `utils/logging.py` |
| **Audit trail** | Entry count, size, open folder, view latest entries, prune older than N days | `.warpcore/audit` via `AuditRecorder` |
| **Dev sessions** | Session manifests captured in developer mode, size, open, clear | `.warpcore/dev/` via `devmode.py` |
| **Storage** | One table: logs · audit · dev sessions · scan cache · recent projects, each with size and a clear action. Shows both the home `~/.warpcore` and the open project's `.warpcore` | Tauri needs a `dir_usage` command |
| **Projects** | Recent projects count and list, clear recents, default projects directory | `recentProjects.ts` |
| **About** | App version, bundled CLI sidecar version and path, Tauri / webview versions, links to docs | Sidecar under `src-tauri/binaries/` |

Notes on specific rows:

- **Scan cache lifetime** presupposes a scan cache. The Account Explorer currently re-scans on every
  open. Building the cache (keyed by profile + region set, stored under `.warpcore/cache/`) is a
  prerequisite for the setting, and the Storage section should show it once it exists.
- **Logs and audit paths are project-relative.** The CLI prefers `./.warpcore/logs` and falls back to
  `~/.warpcore/logs`, and the Tauri host defaults the sidecar's working directory to the home
  directory when no project is open. The Storage section must show *both* locations rather than
  pretending there is one.

**Where they live:** behind a **gear icon pinned to the bottom of the left rail**, labelled
"Settings", exactly where UniFi puts it. `Cmd+,` / `Ctrl+,` opens it. Settings opens as a
**full-workspace view** with a vertical section list on its left and the section content beside it.
The canvas is hidden, not unmounted, so nothing is lost. Escape or the back control returns to the
canvas.

Application settings are the *only* thing in the app that is allowed to look like a settings page,
because they are the only thing that is not a property of an object in the system.

### 4.3 Why not one settings screen with two tabs

Because the two kinds have different owners, different storage, different blast radius and
different collaborators. Putting them side by side invites exactly the mistake the current modal
makes: a personal toggle drifting into a shared file. The separation should be structural, not a
tab label.

---

## 5. Surfaces

### 5.1 Left rail

The left rail is the Resource Library with a pinned footer. It is a palette plus the one global
entry point, not a navigation tree. Do not grow it into a menu of product capabilities; the research
is explicit that capability-driven navigation is the failure mode of mature platforms.

```
┌──────────────────────┐
│ Resource Library     │
│ ▸ Compute            │
│ ▸ Data               │
│ ▸ Messaging          │
│ ▸ ...                │
│                      │
│                      │
├──────────────────────┤
│ ● sidecar ok · dev   │   ambient status: sidecar reachable, dev mode on
│ ⚙  Settings          │   pinned, opens the application settings view
└──────────────────────┘
```

The status line is optional but cheap, and it is the first application of "status is ambient".

### 5.2 Right inspector

Generalise `RightPanel` from "a panel with two tabs" into **the inspector**. It shows the currently
selected object, whatever kind it is.

| Selected object | Inspector shows |
|---|---|
| Nothing | Project summary: name, path, environments, resource count, last deployment, unsaved changes |
| Environment | Identity header (name, id, last deployed), then Removal Policies · Logging · Lambda Defaults, then an **Expert** disclosure showing the exact `warpcore.yaml` fragment for this environment |
| Node | Today's Configuration panel, then Execution Log, then Cost. These already exist; they move in rather than float over the canvas |
| Permission edge | Source → permission → destination, the IAM statement it becomes, and the Roles view scoped to it |

Every inspector body follows **Overview → Evidence → Raw**. For an environment that is: the form →
what the last deployment actually did with these values → the YAML. For a node: the form → the
execution steps and API calls → the raw response and the generated CDK/CloudFormation.

Selection is the only way into the inspector. There is no "Environment" tab to click when no
environment is selected; the tab strip goes away in favour of the object's own identity header.

### 5.3 Toolbar

Reduce it to three groups, left to right:

1. **Scope:** project name (click selects the project in the inspector), environment selector
   (selects the environment in the inspector), unsaved-changes indicator.
2. **Tasks:** Scan project, Explore account. These are jobs, not objects, so a task dialog with
   progress is the right shape, which is what `ScanProgressView` already is.
3. **Actions:** Deploy, Destroy, inspector toggle.

The file menu stays but should read as "Project" rather than "File". The operator is opening a
project, not a document.

### 5.4 Account Explorer

Keep the scan as a task, but land the results in the same workspace-plus-inspector shape as the
canvas: a list or tree of discovered resources on the left, the selected resource's config, network,
metrics and logs in the inspector. That is the Account Explorer's own See → Notice → Select → Inspect
→ Act loop, and it stops being a modal with a modal inside it.

Fix the tooltip that currently reads "Configured in Settings › Regions of interest" so it opens the
Regions section of the settings view directly. Information is navigation.

[Done since: the Explorer's **Create project…** closes the loop from See → Notice → Select → Inspect
to Act. `warpcore discover project` scans with full detail, selects by glob, derives relationships,
and emits canvas-native fields; `utils/projectFromAccount.ts` lays the result out and the same
loader every Open uses brings it onto the canvas. The account becomes one environment, inheriting
its settings from a template or an environment of the open project.]

### 5.5 Status is ambient

Warpcore already has more state than it shows. Surface it where the object is:

- Node: last deployment status as a small semantic dot on the node, not only in a panel.
- Environment selector: which environments have been deployed, which have drifted from `warpcore.yaml`.
- Project name: unsaved changes.
- Left rail footer: sidecar reachable, dev mode on.
- Deploy button: disabled with a *reason* ("no project open", "validation failed: 2 errors"), and
  the reason is clickable.

Use colour only for state. The current toolbar is dark and the panels are light; that is a
mechanical inversion, and the research warns against it. Pick one and design the other deliberately
when the visual pass happens.

### 5.6 Every fact can answer "why?"

The execution log already links a failed deployment to its step, the step to its API call, and the
call to an error and suggested fixes. That is the Firewalla pattern and it is the best thing in the
app. Extend it, do not dilute it:

- A permission edge should explain the IAM statement it generates.
- A cost estimate should break down by resource and by the `executionsPerMonth` assumption.
- A disabled action should say why.
- A drifted environment should show the diff between the file and the last deployment.

---

## 6. Migration from the current code

Ordered so each step ships on its own. Each step is now done; the notes
in brackets say where it landed.

1. **Add the settings view.** [`components/settings/`, `RailFooter.tsx`, `Cmd+,` in `App.tsx`.
   Developer mode and Regions moved out of the environment modal, which no longer exists. The
   Account Explorer's region control now has a gear that opens Settings › Regions.]

2. **Turn the Environment tab into the environment inspector.** [`inspector/EnvironmentInspector.tsx`.
   Opening an environment from the toolbar selects it in the inspector; "Make current" switches
   the deploy scope separately, so inspection and scope stay distinct. While doing this it turned
   out the environment settings were never written to `warpcore.yaml` at all - the generator
   hard-coded two placeholder environments. `configSync.ts` now writes them under
   `environments.<env>` as `name`, `removal_policies`, `logging`, `defaults`, beside whatever
   `account`/`region`/`vpc`/`tags` the file already had, and reads them back.]

3. **Extend `preferences.ts`** [`defaultProfile`, `scanCacheMinutes`, `scanParallelism`,
   `logLevel`, `projectsDir`; the spread-over-defaults pattern kept.]

4. **Tauri commands** [`app_paths`, `dir_usage`, `list_dir`, `open_path`, `clear_dir`,
   `read_text_tail`, `list_audit_entries`, `read_scan_cache`, `write_scan_cache`. Every path
   argument must sit inside a `.warpcore` directory; `clear_dir` also refuses `state` and refuses
   to empty a whole `.warpcore`. The audit trail has no clear action on purpose.]

5. **Scan cache.** [`~/.warpcore/cache/explorer/<profile>__<regions>.json`. The Explorer shows a
   fresh-enough cached scan on open and marks it "cached N min ago"; Rescan always bypasses.
   Parallelism from Settings is passed to the CLI as `--parallelism`.]

6. **Generalise the inspector.** [`Inspector.tsx` with project, node and environment subjects.
   The node subject shows a configuration summary, navigable connections, cost, the execution log
   inline (`ExecutionLogPanel` grew an `inline` prop) and the raw node. The full configuration
   form is still the existing modal, opened from the inspector's Configure button; folding that
   thousand-line form into a 384px panel was not worth the regression risk yet.]

---

## 7. Do not

- Add another modal. Modals are for tasks with progress, and for nothing else.
- Put anything per-project or per-environment in application settings, even temporarily.
- Turn the left rail into a menu of features. It is a palette and a footer.
- Show a setting the app cannot yet honour. The scan cache lifetime waits for the scan cache.
- Invert the theme mechanically. Design dark and light on purpose (§17: the dark palette is chosen by role; grey and the two special surfaces by hand).
- Let the simplified view be a dead end. Every object needs its Raw level, even if it is just JSON.

---

## 8. Open questions

- Should application settings sync between machines at all, or is "this workstation" the whole
  contract? The research leans towards local-only; the audit trail and logs are inherently local.
- Should the environment inspector be allowed to edit an environment that is not the current scope,
  or does selecting an environment for inspection also switch the deploy scope? UniFi keeps
  inspection and scope separate; that is the safer default.
- Does the project deserve its own inspector subject now, or only once there is drift detection to
  show on it?

---

## 9. Drawing an account, not just listing it

Creating a project from an account now draws every resource, and it is
immediately obvious that a grid of boxes is not a picture of a system. The
canvas in the first `gitf` import shows a Lambda, three buckets, four log
groups, three SSM parameters, two security groups and a VPC in five columns,
and answers none of the questions an operator has: what is *in* the VPC,
what the default security group exposes, who can read the secrets. This
section is the plan for that. It is deliberately a plan and not code: the
representation decides what the canvas is *for*, and that deserves a
decision rather than a first attempt.

### 9.1 What the picture has to answer

In order of how often the question comes up:

1. **Where does this run?** Which VPC, which subnet, public or private.
2. **What can reach it?** Which security groups admit what, from where. The
   default security group is a standing question of its own.
3. **What can it reach?** Data stores, queues, secrets, keys, the internet.
4. **Who can read this secret / use this key?** For every secret and KMS key,
   the set of principals with read or write, and through which policy.
5. **What is this thing part of?** Instance → volumes and snapshots; function
   → versions and log group; distribution → origins and certificate.

Today's edges answer part of 3 and none of the rest.

### 9.2 Containment, not edges, for "where"

Question 1 is containment, and containment is a box around things, not an
arrow between them. UniFi draws a site containing networks containing
devices; Proxmox draws a datacenter containing nodes containing guests.

- A **VPC is a group node**: a labelled region on the canvas. Its subnets are
  groups inside it, laid out public on top, private below, one column per
  availability zone. Instances, load balancers, NAT gateways, RDS instances,
  Lambda functions with a VPC config and VPC endpoints sit inside their
  subnet. Internet gateways sit on the VPC's edge.
- **Everything outside a VPC** - S3, DynamoDB, SQS, SNS, Secrets Manager, SSM,
  KMS, IAM, CloudFront, Route 53 - stays in the layered columns, to the right
  of the VPC groups. They are regional or global services; drawing them
  inside a VPC would be a lie.
- React Flow supports this directly with `parentNode` and `extent: 'parent'`;
  moving a group moves its children. The layout becomes: VPC groups first
  (sized to their contents), then the columns.

Route tables and their routes are the exception: they describe *how* a subnet
reaches out, not where it is. They are best shown as a property of the subnet
("routes via rt-1: 0.0.0.0/0 → igw-1") and as a toggleable edge layer, not as
permanent boxes.

### 9.3 Security groups as membership, then as reachability

A security group is not a node an instance connects *to*; it is a policy the
instance is *in*. Drawing it as a box with arrows from every member produces
the hairball on the first import.

- **Membership is a badge.** Each node in a VPC shows the security groups it
  belongs to as small chips. Clicking a chip selects the group in the
  inspector, which lists every member and every rule.
- **Reachability is an edge layer.** With the "network" layer on, an edge from
  group A to group B means "A's members may reach B's members" (the
  `UserIdGroupPairs` rules), labelled with ports. Rules from CIDR ranges are
  drawn from a synthetic "internet" or "10.0.0.0/8" node at the VPC's edge.
- **The default security group** gets an ambient status: a warning dot when
  it has members and its inbound rules admit anything beyond itself, and the
  inspector explains why ("0.0.0.0/0 on 22 from the default group; 2
  instances are members"). This is the "every fact can answer why" rule
  applied to the most common footgun in an account.

### 9.4 Secrets and keys: a vault, with read and write arrows

The ask is exact: secrets collected together, with arrows from what can read
and write them. The same shape serves KMS keys.

- **A vault group** collects Secrets Manager secrets and SecureString SSM
  parameters; a **keyring group** collects KMS keys. Both live in the
  platform column, drawn as a distinct enclosure rather than a row of boxes.
- **Arrows carry direction and verb.** Read is `secretsmanager:GetSecretValue`
  / `ssm:GetParameter*` / `kms:Decrypt`; write is `PutSecretValue`,
  `PutParameter`, `kms:Encrypt`/`GenerateDataKey`. Each arrow is labelled
  with the verb and coloured by it, and the edge inspector shows the policy
  statement that grants it and the role it is attached to.
- **Where the arrows come from.** Today the scanner records a role's attached
  and inline policy *names* only. To draw read/write, hydration has to fetch
  the policy *documents* (`get_role_policy`, `get_policy_version`) and match
  each statement's `Resource` against the emitted ARNs, wildcards included.
  The same pass yields "what can it reach" for buckets, tables and queues far
  more accurately than environment-variable guessing, so it replaces the
  `reference` heuristic rather than sitting beside it. Resource policies on
  the secret or key (`GetResourcePolicy`, `GetKeyPolicy`) add cross-account
  readers.
- **"Encrypted with"** edges from buckets, queues, tables, logs and secrets to
  their key stay as they are, but move into the keyring's edge layer.

### 9.5 Sub-resources fold into their parent

Volumes and snapshots belong to an instance; versions belong to a function;
origins and the certificate belong to a distribution; the SSM managed
instance record is the instance. None of these needs a box. They appear as
a section in the parent's inspector ("Storage: 2 volumes, 7 snapshots") and
as a small count badge on the node. Drawing them was the right first step
because it proved nothing is dropped; folding them is the second.

### 9.6 Layers

Even with containment and the vault, an account with every edge drawn is
unreadable. The canvas gets a layer control, like map layers:

| Layer | Edges | Default |
|---|---|---|
| Triggers | event sources, rule targets, subscriptions, invokes | on |
| Access | read/write arrows from policy documents | on |
| Network | security-group reachability, routes | off |
| Encryption | "encrypted with" | off |
| Plumbing | log groups, instance profiles, execution roles | off |

Selecting a node shows all of its edges regardless of layer, dimmed for the
layers that are off. That keeps the default picture calm and keeps every
relationship one click away, which is the whole design rule of this document.

### 9.7 Order of work

[All four steps below shipped on 2026-09-02. Policy documents are hydrated
(`get_role_policy`, `get_policy_version`, plus secret resource policies and
KMS key policies) and become `access` connections with a read/write/admin
verb, the granting role and a sample of actions; an access arrow replaces
the environment-variable guess for the same pair. VPCs and subnets are
container nodes (`ContainerNode`, React Flow `parentNode`), laid out with
VPC-level things in a strip and subnets in a grid, public first. Security
groups are badges on their members, membership and trust edges live on the
network layer, and a default group open to the world with members carries a
warning the inspector explains. The vault and keyring became the general
rule: every top-level node outside a VPC joins an `enclosure` container by
role (`ENCLOSURES` in `projectFromAccount.ts`), one per role per region,
laid out in columns; empty subnets are slim spines rather than partitions. Volumes, snapshots, Lambda versions and SSM managed
instances fold into their parent's "Attached" section. Five layers with
counts sit over the canvas; selection reveals off-layer edges dimmed.]

1. Policy-document hydration and the access edges (§9.4). Highest value:
   real read/write arrows for secrets, keys, buckets, tables and queues.
2. VPC and subnet group nodes with containment layout (§9.2), and security
   group badges (§9.3). This is the change that makes the canvas a map.
3. Layers (§9.6), because 1 and 2 together produce too many edges without it.
4. The vault and keyring enclosures (§9.4), the default-group warning (§9.3),
   and folding sub-resources (§9.5).


## 10. Lenses, the palette, and an honest deploy loop

[2026-09-04. The assessment and plan are in `UX_PLAN.md`; this section records
what changed in the model.]

- **Lenses** generalise §9.6. A layer hides or shows one kind of edge; a lens
  answers a question ("what is the security picture?") by choosing the layers
  *and* deciding which nodes are the subject. Context nodes are dimmed, never
  hidden, so the map keeps its shape; containers and the selection's
  neighbourhood are always the subject. `utils/lenses.ts`, `LensBar.tsx`.
- **The command palette** (`⌘K`) is the one fast path to any object or action.
  It does not replace selection as the way into the inspector; it is a way to
  select without hunting. `CommandPalette.tsx`, `utils/palette.ts`.
- **The Activity drawer** is the Evidence level for a deployment: the CLI's
  own `--progress` events, drawn as they arrive, with the raw output one tab
  away. Nothing on it is simulated. `ActivityDrawer.tsx`, `utils/deployEvents.ts`,
  `utils/deployRunner.ts`, `run_progress.py`.
- **Derived, not stored.** Validation classes and lens emphasis are computed at
  render time. Decorating a node is not editing the project.
- **Undo and redo** live in the store: selection-only changes are not steps,
  and a burst of changes (a drag) folds into one.
- **One chrome.** The toolbar joined the light theme; colour is for state and
  for Deploy and Destroy.
- **Three.js was considered and declined** for the editing surface (§2.5 of
  the plan). Depth is served by lenses; a read-only 3D overview remains an
  option once the lenses have proved what the strata are.


## 11. The application stack

[2026-09-08. Proposal and mockups in the "Application Stack" design note;
shipped in `utils/applications.ts`, `utils/stackLayout.ts`, and the tile and
band cases of `ContainerNode`.]

§9's enclosures grouped resources by AWS category and laid the groups out in
columns. That is AWS's taxonomy, not the application's, and it produced a
strip with no top or bottom. The canvas of an imported account is now **one
tile per application** with **five bands in request order**: entry, compute
(the VPC inside it), bus, data, platform. Width is bounded, bands wrap and
only exist when they have members, platform resources are chips.

- **Clustering** decides the tile: tags, then a name prefix shared by three
  or more resources (or the project's name), then the wiring. A platform
  resource wired into two applications is shared. A single application
  absorbs its shared bits; a monorepo gets a Shared platform tile. Every
  assignment carries a reason the inspector shows.
- **Lenses remove on computed layouts.** `reflowStack` hides the context
  nodes, drops empty containers, lays out what remains, and counts what
  went per band. Hand-drawn canvases keep dimming.
- The old `enclosure` nodes still render, so older files open unchanged.

## 12. Scenarios

[2026-09-08. Designed in the "Application Stack" design note, §Scenarios;
shipped in `utils/scenarios.ts`, the `scenarios` and `playhead` slices of
the store, `inspector/ScenarioInspector`, and `ScenarioTransport`.]

A scenario is a named event played step by step through the resources it
touches. It is **data in `warpcore.yaml`** (`scenarios:`), not a recording
on this machine, so it is versioned and reviewed with the project. Each
step names a node on the canvas; a note, a `takes` duration and a
`detached` flag are optional. Log groups are never steps: every compute
step's log edge is pulsed during playback and synthetic lines stream into
the group, which shows data moving without claiming to know what the code
logs.

- **Checked, not just drawn.** Every hop is matched against the wiring the
  import found or the operator drew: invocations, event sources and
  targets, DNS and origins, access arrows from IAM policies, hand-drawn
  permission edges. The evidence for a hop is looked for from the nearest
  earlier step, so "authorizer, then the key it reads, then the function"
  resolves the function's hop back to the API. A hop with nothing behind it
  and a compute step with no log group are flagged in the inspector and on
  the transport bar. That check is the point: a scenario that passes says
  "this request can happen, and here is the policy that lets it."
- **One playhead in the store.** Playback is two facts - which step, and
  whether the request is travelling to it or dwelling on it - plus playing
  and speed. The transport bar owns the clock and advances the playhead
  when a phase ends; everything continuous (the pulse along the edge, the
  segment fill, the log-group ticker) is CSS driven by those facts. The
  store therefore changes a handful of times per scenario, and any other
  view of the system (the 3D system view, §13) reads the same playhead and
  shows the same instant.
- **Derived marks.** Step numbers, node states, the pulse edge, the lit log
  groups and the dimming of everything else are computed in `App` from the
  playhead and put on the *view* nodes and edges, never in the store: they
  are a view of the playhead, not project state, and must not mark the
  project dirty or become undo steps. The scenario's own edges (hops and
  log writes) always draw, whatever the edge layers say.
- **Recording is clicking.** With Record on, a click on a resource appends
  it as the next step; the inspector also offers the hops the graph allows
  from the last step, and "Suggest a path" drafts the steps with a
  depth-first walk (triggers first, then access, then references). Editing
  a scenario is a project change and respects the lock; playing never does.
- **Stacking on the canvas.** Containers, edges and resources have explicit
  z levels (0, 1, 2) so a line runs above an opaque tile and under a card.
  React Flow puts everything at 0 otherwise, and an opaque application
  tile hid every edge.

## 13. The system view

[2026-09-08. §2.5 said a 3D scene earns a place only as a read-only
presentation of what the 2D lenses have proved, driven by the same
playhead. Shipped in `utils/systemLayout.ts` (pure, tested) and
`components/SystemView.tsx` (three.js).]

- **Terraces, not a cake.** Each band keeps its footprint from the canvas
  and is raised by its order: entry highest, platform lowest. A layered
  cake would occlude; terraces let the request be seen walking down the
  stairs, which is how the stack reads in 2D. Plates are trimmed to what
  sits on them. A VPC is a slab on the compute plate, a subnet a slab on
  the VPC, and what runs inside is raised accordingly. A hand-drawn canvas
  is one sheet.
- **Same store, same instant.** The view derives its geometry from the
  nodes and edges plus the lens re-flow (`useLensView`) and its decoration
  from the scenario view (`useScenarioView`), the same hooks the canvas
  uses. Selection, layers, lens and playhead are read, never duplicated.
  The only state the view owns is the camera and the wall-clock start of
  the current hop, which it needs to place the pulse between store updates.
- **Read only.** A click selects (or, while recording, appends a step);
  nothing drags, connects or configures. The lock, the palette, the
  inspector and the transport bar work unchanged over it.
- **Labels are HTML.** Names and step badges are CSS2D objects, so they
  stay crisp and use the same classes as the canvas; the WebGL scene draws
  only plates, cards, arcs and the pulse.
- **Follow pans.** Following the request moves the camera and the orbit
  target by the same offset, so the viewpoint the operator chose is kept.

## 14. The Holodeck

[2026-09-08. Plan and shipped state in `HOLODECK_PLAN.md`.]

- **A library, not a template gallery.** Every entry is a system with
  scenarios, laid out by the same stack layout an imported account gets,
  so a walk through an example and a walk through a real account look the
  same. Entries are authored without coordinates; hand placement is how
  templates rot.
- **Preview writes nothing.** It is the demo account generalised: in
  memory, read-only, the open project stashed and restored. It refuses when
  something unsaved would be lost, and says why. Save a copy is the only way
  to a file, and it goes through the one project-creation path.
- **Honest labels.** Reference, inspired by (with the source and year, no
  branding), textbook, starter. An "in the style of" entry is a rendering
  of a public description on AWS services and says so on the card and in
  the inspector.
- **The unhappy path is the point.** A diagram shows the happy path; the
  simulator shows the timeout, the retry, the dead-letter queue, the lost
  request. Failure is data on the step (`outcome`, `retry`), the check
  treats an uncaught failure as a note, and the canvas shows it in red.
- **Notes travel with the project.** `meta.note` is how an entry teaches
  and how a user annotates their own system; the same field, the same
  marker.


## 15. The command layer

[2026-10-12. `visual-builder/src/commands/`.]

Everything the app can do is a command, declared once, and every surface
is derived from the declaration: the palette's rows, the shortcut table,
the receipts in the Activity drawer, the tool schemas a model is handed,
and what an outside agent reaches over MCP. The toolbar, the keys, the
palette, the inspector and the assistant all run the same command through
the same dispatcher (`dispatch.ts`), which checks the arguments, asks the
lock and the command's own `available()`, confirms an `aws-change`
command whoever asked, runs it, and writes a receipt whatever happened.
Parity between the UI and an agent is therefore a property of the design,
not a list someone keeps in step.

Kinds are split by consequence: `view` (this operator's screen), `project`
(the canvas and scenarios; respects the lock, lands in undo), `file` (the
project's own files beside it: save, the lock itself, finding mutes;
immediate, not undoable, not under the lock), `aws-read` (slow, changes
nothing), `aws-change` (always confirmed), `query` (exact answers from
what the app holds, so a model never has to guess at the graph).

The shape was taken from CORA's review assistant and changed in six
places, recorded here because each is a rule for adding a command:

- One declaration, not four. CORA writes an action's schema, its confirm
  text, its execution and its editability in separate places; here they
  are fields of one `CommandSpec`, and `is_action`-style derivations are
  the only way to get a list.
- The registry lives where the state lives. CORA's actions are Rust over
  SQLite and reach frontend-held state through an emitted event; ours are
  TypeScript over the store, and the backend reaches in.
- Availability is declared (`available`, `ignoresLock`), shown as the
  palette subtitle, and handed to an agent as the answer, rather than
  discovered by an error.
- Queries are first class, so questions are tool results, not prose.
- Confirmation and the receipt are the dispatcher's, so no command can
  forget either.
- Arguments are typed once and validated once; the JSON schema is derived.

Rules: a new UI action is a new command first, and the button calls it.
Do not call `setNodes`/`setEdges` from a component for a project edit;
make the command and run it. A command that changes AWS or the deployment
state is `aws-change` and gets a `confirm` that says what will happen.


## 16. The assistant and the bridge

[2026-10-12. `visual-builder/src/assistant/`, `src-tauri/src/main.rs` (Bridge), `warpcore/assistant/`, `warpcore/mcp_server.py`.]

The assistant is the command layer with a model in front of it. The loop
runs in the app (`assistant/loop.ts`): one model turn at a time through a
`warpcore assistant serve` worker the host keeps for the session (the
bundled CLI takes seconds to start), which maps one message shape to every
provider and keeps no state between turns; every tool the model calls is a command run through
the dispatcher with the source marked `assistant`. Queries give it exact
answers, so it is told to read before it acts. An `aws-change` command
waits on a card (`assistant/confirm.ts`), one at a time; a second in the
same turn is answered "ask again after the pending one resolves". The
receipts are the transcript's tool lines, and the model is told not to
recap them.

The bridge is the same door for an outside agent. The app listens on a
loopback port, records it with a token in `~/.warpcore/app.json`, and
turns each request into a Tauri event the webview answers by running the
command with the source marked `mcp`. `warpcore mcp` finds the file,
publishes the app's commands as MCP tools next to the file tools, and a
change to AWS asked for over MCP shows the same card in the panel. Without
the app, the file tools are what there is.

Rules: the model never gets a tool that is not a command; nothing other
than the operator answers a card; a new command is automatically a tool
for both.


## 17. Themes

[2026-10-12. `visual-builder/scripts/build-theme.mjs` → `src/theme.css`, `src/utils/theme.ts`.]

Every colour in the app resolves through a token. Tailwind's palette is
rebound so `bg-gray-50`, `text-red-700` and the rest read CSS variables,
and one attribute on `<html>` (`data-theme`) switches the whole app; the
canvas stylesheet, the SVG edges and pulses, the minimap and the 3D view
read the same variables. The class names were kept because the app uses
them by role: 50 is a soft background, 200 a border, 500 and 600 a solid,
700 to 900 text on a tint.

The dark palette is designed by role, not inverted. Grey is hand-picked
(it is the chrome). For a hue, the tint steps become dark tints mixed
towards the canvas, the solids stay as bright as the light 500 so icons
and buttons keep their weight, and the text steps become the hue's light
steps so words on a tint stay readable. Four roles are themed on purpose
rather than by scale: `white` is always white (text on a coloured
button); `surface` is what a card or panel paints (white, or the dark
surface); `strong` is the inverse surface (a black button on light, a
white one on dark); `chrome` is dark in both (code, logs, the transport
bar). Nothing opts out of the theme: a surface that must stay dark uses
`chrome`, and the one dark dialog became a light one like the rest.

The preference (`appearance`: system, light, dark) lives in application
settings, follows the OS when asked, and is a command (`view.appearance`)
so the palette and an assistant can switch it. `theme.test.ts` fails the
build when a colour class has no token or a component paints a literal
colour the theme cannot reach.

Rules: never write a hex colour in a component or stylesheet; put a
`var(--c-…)` in a class or a style prop, where CSS resolves it. SVG
presentation attributes and icon props do not resolve `var()`, so colour
them through `style` too; `rc()` and `cssColorHex()` exist only for a
library callback and three.js, and re-read on a theme change through
`useThemeVersion()`. A new hue goes into `scripts/theme-palette.mjs`,
which the generator and the Tailwind config share. A surface that must
stay dark uses `chrome`; one that must invert uses `strong`; a panel
paints `surface`, never `white`.


## 18. Placement is the canvas's job

[2026-10-13. `visual-builder/src/utils/autoLayout.ts`, `src/commands/canvas.ts`.]

Nothing that adds a resource says where it goes. A canvas that has been
laid out, imported, or opened from the Holodeck is *arranged*: it has
application tiles, and every later edit is drawn into them. Adding a
resource, wiring one, or removing one redraws the canvas; the resource
lands in its application's tile, in a band chosen by what it is, with the
other tiles moving aside. `canvas.addNode` takes `app` (which application
it belongs to) and `canvas.setApplication` moves one between them; both
are names, never coordinates. A canvas with no tiles is a freehand
sketch and is left exactly where its author put things, until
`canvas.layout` arranges it.

Coordinates survive for one case only: a drop or a drag at the pointer,
where the operator is placing something themselves. `canvas.move` is not
offered to a model at all, and `canvas.addNode`'s x and y say in their
own description that an arranged canvas does not need them.

The redraw is the dispatcher's, not each command's: after any `project`
command whose run changed the nodes or the edges, the canvas is arranged
again, so no command can forget and none has to remember. A command that
places something itself (a drag) opts out with `keepsPlacement`.

Grouping has one home: `meta.application` on the node, which is canvas
state. The import works it out from tags, names and wiring; the operator
overrides it by name and that choice (`reason: CHOSEN`) survives every
later layout. It is deliberately not an AWS tag: the compiler reads
`config.tags`, and moving a card between tiles must never show up in a
deploy plan.

Rule: a new command must never ask its caller for a position, and must
never write a view choice into `config`.
