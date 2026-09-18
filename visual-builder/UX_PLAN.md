# Visual Builder: UX assessment and plan

**Date:** 2026-09-04
**Question asked:** is this version too far off track to keep, and what would make it intuitive
and easy to manage?

## 1. Verdict: keep it

The Visual Builder is not off track. Its foundations are the right ones for a control surface
and match what the best operator tools do:

- A real object model (Project → Environment → Resource → Connection → Deployment) with an
  inspector that shows whatever is selected, and settings split by ownership
  (`DESIGN_GUIDANCE.md` §2 and §4).
- A canvas that is a map, not a list: VPCs and subnets as containers, security groups as
  badges, secrets in a vault, sub-resources folded into their parent, and edge layers.
- An Account Explorer that reverse-engineers a real account into a project, including access
  arrows derived from IAM policy documents.
- Tauri v2 + React Flow + Zustand + Tailwind: light, well-understood, and everything above is
  built on them without fighting them.

Rewriting would throw away the parts that are hard to get right and keep none of the problems,
because the problems are not architectural. They are listed below, worst first.

## 2. What is actually wrong

### 2.1 The deploy loop is not real (blocker)

Three independent facts, found by reading and running the code:

1. **The app's Deploy button runs a mock.** `Toolbar.handleDeploy` imports
   `createMockDeploymentUpdates` and animates node colours on a timer, while calling the CLI
   through the generic `execute_cli_command` and ignoring what it says. The `useDeployment`
   hook and the Rust `execute_deployment` command that parse real output exist but are not
   wired to the button.
2. **The CLI's `deploy` and `destroy` crash before doing anything.** `RichProgressCallback`
   subclasses `Callable[...]`, so Python treats it as an ABC with an abstract `__call__` and
   refuses to instantiate it:
   `TypeError: Can't instantiate abstract class RichProgressCallback without an implementation for abstract method '__call__'`.
3. **The orchestrator never builds resources from the config.** `_build_agent_resources` and
   `_build_shared_resources` in `orchestrator.py` are placeholders returning `{}`, so a plan
   is always empty and `deploy` reports "No changes to deploy". The planner, executor,
   provisioners (Lambda, IAM, S3, DynamoDB, SQS, SNS, API Gateway, VPC, security group,
   CloudWatch), state, checkpoints and audit trail are all built and tested; the compiler in
   the middle is missing.

For an operator, the first press of Deploy is the moment the product earns or loses trust.
Today it shows a green animation while nothing happens.

### 2.2 Navigation has no fast path

There is no way to find a resource by name, jump to it, or run an action without hunting for
it. Every serious control surface has a command palette. The README also lists keyboard
shortcuts (⌘S, ⌘O, ⌘D, ⌘Z, ⇧⌘Z) that are not implemented.

### 2.3 "Layers" are edges only

The layer control hides and shows edges. It cannot answer "show me the security picture" or
"show me the network picture", because those are views of the *nodes* too: a security view
should foreground security groups, roles, secrets, keys and anything flagged, and push the
rest into the background. That is what the request for "security / network / all" layers is
asking for.

### 2.4 Legacy surfaces that fight the model

- `DeploymentTimeline` draws a fixed 0-60 s axis with bars that always start at 0.
- The configuration form is a 1,600-line centred modal that hides the canvas.
- The toolbar is dark, everything else is light: a mechanical inversion the design guidance
  itself warns against.
- No empty state: a new user sees a blank dotted canvas and "No project open".
- Validation writes `className` into the store through `setNodes`, which marks the project
  dirty and triggers an auto-save on every open.

### 2.5 Three.js

Not for the editor. A 3D scene makes every core interaction worse: text is harder to read,
nodes occlude each other, drag-to-connect needs depth picking, and orbit/pan/zoom is a skill
the operator has to learn before they can do anything. Nothing about an AWS account is
three-dimensional; the "depth" people want from 3D is layering, and layering is better served
by lenses (below) that dim what is irrelevant instead of stacking it behind something else.

Where 3D could earn a place later: a read-only "exploded" overview of a large account, where
lenses become physical strata and the operator flies through them. That is a presentation
mode, not the editing surface, and it should only be built once the 2D lenses have proved what
the strata should be.

## 3. The plan

Ordered so each step is shippable and verifiable on its own. Steps 1-8 are implemented in
this pass; step 0 is the backend work that turns Deploy from honest into useful.

### 0. Build the config → resources compiler (backend, next)

[Shipped 2026-09-18: `src/warpcore/orchestrator/compiler.py`. The canvas is
the source of truth; a hand-written project is lifted into the same shape.
Discovered resources are observed, never created, updated or deleted; a
destroy leaves adopted resources alone unless `--include-adopted`. A
function without code gets a stub. References between resources
(`orchestrator/refs.py`) resolve against the state and at provision time.
Deletes run after the waves; a partial failure rolls back by default.
`diff` shows property changes, whether code redeploys, and IAM actions
gained or lost. Verified end to end under moto in
`tests/orchestrator/test_deploy_moto.py`.]

`DeploymentOrchestrator._build_agent_resources` and `_build_shared_resources`:

- Per agent: `AWS::IAM::Role` (`RoleName`, `AssumeRolePolicyDocument`, `InlinePolicies` from
  the project's connections), `AWS::Logs::LogGroup`, `AWS::Lambda::Function` (`FunctionName`,
  `Runtime`, `Handler`, `CodePath`, `Role`, `MemorySize`, `Timeout`, `Environment`), with
  dependencies role → log group → function. The provisioners already read exactly these
  property names.
- Per entry under `resources:`: the matching provisioner type (S3, DynamoDB, SQS, SNS, ...).
- Shared: VPC and API Gateway when enabled.
- Connections → IAM statements on the granting role, using the same rules
  `visual-builder/src/utils/rolePolicy.ts` already encodes for the canvas.

This is real AWS work and should be built with the `--progress` protocol below and tested
against a sandbox account before it is wired to a production environment.

### 1. Make the deploy loop honest (this pass)

- Fix the `RichProgressCallback` crash.
- `warpcore deploy --progress` and `warpcore destroy --progress`: NDJSON on stdout, one
  event per line: `plan` (every resource id, its change type and wave), `resource`
  (`in_progress` / `success` / `failed` / `skipped`, with error and duration), `complete`
  (status, counts, duration). Same shape the discovery commands already use.
- Rust `execute_deployment` / `execute_destroy` pass `--progress`, forward each JSON line as a
  `deployment-update` event and everything else as `cli-output`. The old regex scraping of
  Rich output goes.
- The Deploy button runs the real command and nothing else. A new **Activity** drawer along
  the bottom of the canvas shows the run: status, elapsed time, every planned resource with
  its real start and end, errors, and the raw CLI output. An empty plan says so in words.

### 2. Command palette (⌘K)

Resources by name, type, id or ARN; environments; and every action in the app (deploy,
destroy, open, save, the Holodeck, explore, discover, lenses, layers, settings sections, fit
view, lock). Selecting a resource selects it, opens the inspector and pans the canvas to it.

### 3. Lenses

A segmented control over the canvas: **All · Security · Network · Data flow · Cost**. A lens
sets the edge layers *and* a node emphasis: nodes the lens is about are drawn normally, the
rest are dimmed to context. The selected node and its neighbours are never dimmed. Cost draws
each node's monthly estimate on the node. The existing layer checkboxes remain as the expert
control beside the lens bar.

### 4. Shortcuts, undo and redo

⌘K palette · ⌘S save now · ⌘O open · ⌘D deploy (respects the lock) · ⌘Z / ⇧⌘Z undo and redo
· ⌘0 fit view · ⌘, settings · `1`-`5` lenses · `?` shortcut help · Esc deselects or closes.
History coalesces drag moves into one step and ignores selection.

### 5. Welcome state

When nothing is open the canvas shows what to do: open a project, pick a recent one, start
from a template, explore an account, or drag a resource on. Three lines explain the model
(design → deploy → inspect).

### 6. One visual system

The toolbar joins the light chrome of the rest of the app. Colour is reserved for state and
for the two actions that change AWS.

### 7. Configuration as a sheet, not a modal

The configuration form slides in from the right over the inspector and leaves the canvas
visible and interactive-looking, so editing a resource never means losing the picture.

### 8. Status is ambient on nodes

Every node carries a small semantic dot (draft, ready, deploying, deployed, failed, present)
in addition to its tint, and the minimap uses the same colours.

### Derived, not stored

Validation results and lens emphasis are computed at render time from the store, never
written back into it. Opening a project no longer marks it dirty.

## 4. Verification

- `npx tsc --noEmit`, `npm run build`, `cargo check`, `pytest` for the new CLI tests.
- `npm test` (vitest) for lenses, palette ranking, history coalescing and progress parsing.
- Rebuild the sidecar (`python packaging/build.py --sidecar`) so the app runs the CLI with
  `--progress`; the app fails at build time without a matching sidecar.
- Run the app and drive it: open a project, ⌘K to a node, switch lenses, press Deploy and
  read the Activity drawer.


## 5. Follow-up, 2026-09-08: the application stack and scenarios

Shipped: an imported account is drawn as one tile per application with five
bands in request order (entry, compute with the VPC inside it, bus, data,
platform as chips); resources are clustered by tags, name prefix, then
wiring, with the reason shown in the inspector; lenses on a computed layout
remove rather than dim and re-flow the tile. See DESIGN_GUIDANCE.md §11.

Scenarios, shipped 2026-09-08: a scenario is a named event played step by
step through the resources it touches, stored in `warpcore.yaml`
(`scenarios:`), recorded by clicking hops or drafted from the graph, and
played with a transport bar over the canvas. Every hop is checked against
the wiring (a hop with no permission or trigger is flagged, and so is a
function with no log group), and log groups tick with synthetic lines to
show data moving. One playhead in the store drives every view. See
DESIGN_GUIDANCE.md §12.

The system view, also shipped 2026-09-08: the canvas as terraces in
three.js, read only, reading the same lens, selection and playhead, so a
scenario plays identically in both. DESIGN_GUIDANCE.md §13.

Next: the Holodeck, a library of example systems with scenarios and a
drawer to preview and copy them. Plan and the state it builds on:
HOLODECK_PLAN.md.
