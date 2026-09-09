# The Holodeck: a library of systems to walk through and copy

**Date:** 2026-09-08
**Status:** built 2026-09-08, steps 1 to 5 of §2.5. §0 says what shipped
and where it differs from the plan; §1 onward is the plan as written.

## 0. What shipped

- **Entry format and loader.** `utils/holodeck.ts` parses
  `visual-builder/holodeck/*.yaml` (bundled by `utils/holodeckLibrary.ts`
  with `import.meta.glob`). Entries are the account-project shape without
  coordinates; the loader synthesises ARNs, ids (`lambda-create-link`), one
  execution role per compute resource, one log group per compute resource,
  access actions per target type, and resolves scenario steps by resource
  name or id. Connection sugar: `reads`, `writes`, `uses`, `admin`; `in:`
  for VPC and subnet containment; `groups:` for security groups; `note:` on
  a resource. Loaded canvases carry no ARN or region and every node is
  `configured`. `holodeck.test.ts` loads every bundled entry and fails if
  any scenario has a problem.
- **Library.** Twenty-four entries in four families: six AWS reference
  architectures, four "in the style of" (Slack, Discord, Uber, Twitter,
  each with its public source and year), seven classics, and a fourth
  family the plan did not have, **starters**: the seven old built-in
  templates migrated, laid out, with scenarios. Every family has unhappy
  paths.
- **The drawer.** `components/HolodeckDrawer.tsx`: families, search,
  cards with SVG thumbnails (`utils/thumbnail.ts`), a detail pane with the
  look-at notes, scenarios and source, Preview and Save a copy. The Mine tab
  holds custom templates; `TemplateModal.tsx` is gone. Opened from the
  toolbar, the palette, the welcome screen and the inspector.
- **Preview.** `utils/holodeckActions.ts`. In memory, read-only
  (`selectReadOnly` includes `holodeckPreview`), no file; the open project
  is stashed once and restored on close; refused with a reason when
  something unsaved would be lost (the plan's open question, answered:
  refuse). A banner across the canvas says so; the project inspector shows
  the entry's notes and source. **Save a copy** writes
  `<dir>/<name>/warpcore.yaml` with a `holodeck:` block (round-tripped by
  `configSync.ts`) and opens it unlocked. `write_config_file` now creates
  the folder.
- **Failure paths.** `ScenarioStep.outcome: ok | fail | timeout` and
  `retry: n`; `Playhead.attempt`; `advance` replays the hop per retry;
  states `failing` (red glow, the request dying here) and `failed` (red
  ring, once passed); ERROR log lines per failed attempt; modelled time
  counts attempts; `checkScenario` returns `notes` for an uncaught failure,
  never a problem. Dead-letter connections are kept as edges on import
  (`isDLQ`, amber, dashed) and are playable hops; `App.tsx` no longer
  synthesises a second edge for a pair that has one.
- **Annotations.** `meta.note` on a node: a marker on the card, a section
  in the node inspector (editable when unlocked), saved with the project.
- **Node types.** `cognito`, `opensearch`, `glue`, `athena`, `waf` in
  `discoveredTypes.ts`, the band table, `CANVAS_TYPES`, `NAME_FIELDS`, the
  lens sets and the log verbs.
- **Also.** A measured width or height is no longer a dirty change or an
  undo step, so a freshly loaded canvas stays clean.

Still open: custom templates stay in `localStorage`; the CLI does not ship
the entries (`warpcore init --example`); scenarios still model one forward
path, no branches.

## 1. What exists today (shipped 2026-09-08)

Branch `chore/rename-to-warpcore`, pushed. Commits `a811886` (scenarios),
`ccca443` (system view), `8fc68a0` (cleanup). Frontend in `visual-builder/`:
React 18, React Flow 11, Zustand, Tailwind, three.js 0.170, vitest (77 tests,
`npm test`), `npx tsc --noEmit`, `npm run build`. The user's `npm run
tauri:dev` on port 1430 runs for days; never start another. Details of the
design are in `DESIGN_GUIDANCE.md` §10 to §13 and `README.md`.

### 1.1 The canvas of an imported account: the application stack

`utils/applications.ts` clusters resources into applications (tags, then a
name prefix shared by three or more, then wiring). `utils/stackLayout.ts`
draws one **tile** per application with five **bands** in request order:
entry, compute (VPC inside), bus, data, platform (compact chips). Node types
`application` and `band` are containers (`nodes/ContainerNode.tsx`).
Lenses (`utils/lenses.ts`: all, security, network, dataflow, cost) *remove*
nodes on a computed layout and re-flow the tile (`reflowStack`); hand-drawn
canvases dim instead. `buildCanvas(project: AccountProject)` in
`utils/projectFromAccount.ts` turns an account payload (resources with
`type`, `name`, `arn`, `config`, `tags`; connections with `kind` and
`detail`; roles) into laid-out nodes and edges. Edges carry
`data.meta.layer` (`utils/layers.ts`) and `data.meta.discovered` /
`data.meta.access`.

### 1.2 Scenarios

A **scenario** is a named event played step by step through the resources
it touches. Data in `warpcore.yaml` under `scenarios:`:

```yaml
scenarios:
  - name: Webhook received
    trigger: { at: api-gateway-gitf-api, event: POST /webhook }
    steps:
      - at: lambda-gitf-authorizer
        takes: 40ms
        note: validates the signature
      - at: kms-key-gitf-key
      - at: lambda-gitf
        takes: 180ms
      - at: dynamodb-gitf-sessions
      - at: sns-gitf-events
        detached: true      # fire and forget
```

`utils/scenarios.ts` holds everything pure:

- Model, YAML round trip (`scenariosFromYaml`, `scenariosToYaml`,
  `parseTakes`, `formatTakes`), `createScenario`, `canBeStep`,
  `COMPUTE_TYPES`.
- **Hop index.** `hopIndex(nodes, edges)` is the graph as a request sees
  it: per node the hops it can take (triggers, access arrows, references on
  the access or encryption layer, hand-drawn edges), best first, and the
  log groups wired to it. Built once per (nodes, edges) and passed to
  `checkScenario`, `suggestPath` (depth-first draft of a path) and the
  synthetic log lines. `hopFor` is written on top of `layerFor` and
  `TRAFFIC_KINDS` from `utils/layers.ts`.
- **Checks.** `checkScenario` finds the evidence for each hop from the
  nearest earlier step (so "authorizer, then its key, then the function"
  resolves the function's hop back to the API). A hop with nothing behind
  it and a compute step with no log group are problems. `StepCheck` carries
  `evidence {from, label, actions, edgeId, reverse}`, `logGroups`,
  `logEdges`, `problems`.
- **Playhead.** `Playhead {scenarioId, index, phase: travel|dwell|end,
  playing, speed}`. Two facts; everything continuous is CSS or the 3D
  frame loop. `advance`, `seekTo`, `phaseDurationMs` (travel 700 ms, dwell
  clamped 900 to 3000 ms, over speed), `stepsDone`, `modelledTimeMs` (sum
  of `takes`, default 100 ms, detached steps excluded), `playbackMarks`
  (per node: step numbers and state pending/travelling/active/visited;
  the pulse edge; log edges and log groups lit).
- **Synthetic logs.** `syntheticLogLines` per compute step: START, the
  event or note, one line per resource the step itself calls (from the hop
  index, so a queue fed by the step's topic is not listed), END, REPORT.
  Seeded, so stable. `logLinesUpTo` accumulates them at the playhead.
  Log groups are never steps.

Store slice (`store/useStore.ts`): `scenarios`, `setScenarios`,
`addScenario`, `newScenario(triggerAt?)`, `updateScenario`,
`removeScenario`, `inspectedScenario`/`inspectScenario` (precedence in the
inspector: environment, then scenario, then node, then project; selecting
a node clears the scenario unless recording), `recording`/`setRecording`/
`recordStep` (a click on a resource appends it), `playhead`,
`playScenario`, `stopPlayback`, `setPlaying`, `advancePlayback`,
`seekPlayback`, `stepBack`, `stepForward`, `setPlaybackSpeed`,
`followPlayhead`, `deselectAll`, `systemView`/`setSystemView`. Editing a
scenario respects the project lock; playing does not.

Hooks (`hooks/useCanvasView.ts`): `useLensView` (emphasis and re-flow),
`useScenarioView` (scenario on show: the one playing, else the one in the
inspector; check memoised on the wiring only, marks on the playhead;
`focus {at, from}`; `name(id)`), `ScenarioMarksContext` (badges in
`nodes/NodeWrapper.tsx`), `edgeView(edge, layers, selectedNode, sv)` (the
one rule for visibility and emphasis, used by `App.tsx` and the system
view; the canvas writes it as `data.view`, read by
`edges/PermissionEdge.tsx`). `hooks/usePlaybackClock.ts` advances the
playhead; mounted once in `App`.

UI: `inspector/ScenarioInspector.tsx` (name, trigger picker, event, step
list with note/takes/detached/reorder, evidence and problems per step,
Next hops while recording, Suggest a path, Logs ticker while playing,
Check summary, delete), `inspector/ScenarioRow.tsx` (used by the project
and node inspectors), `components/ScenarioTransport.tsx` (play, pause,
step, jump, speed, follow, stop), palette entries, shortcuts (space, `[`,
`]`, Esc). CSS classes `scn-*` in `index.css`. Containers, edges and
resources have explicit z levels (0, 1, 2) in `App.tsx`; the edge label
layer takes `--edge-z`.

### 1.3 The system view

`components/SystemView.tsx` (three.js) with the geometry in
`utils/systemLayout.ts` (pure, tested): bands become terraces (entry
highest, platform lowest, footprints from the canvas, trimmed to content),
resources are cards, edges are arcs, a VPC is a slab on the compute plate
with subnets on top, a hand-drawn canvas is one sheet. Read only: a click
selects, or records a step. Reads the same lens re-flow (passed as a
prop from `App`), selection, layers and playhead. Labels are CSS2D with
the same `scn-badge` classes. Geometry is rebuilt only when a placement
changes (`layoutKey`), frames render on demand, follow pans the camera
with the request. Toolbar cube button and palette toggle `systemView`.

### 1.4 The demo account

`utils/demoAccount.ts` is a synthetic "gitf" account (API, authorizer,
function, indexer, key, table, topic, queue, bucket, secret, three log
groups, one role, seventeen connections) with the webhook scenario. Dev
builds expose `window.__warpcore = { useStore, canvas, buildCanvas, demo,
systemView }`; `__warpcore.demo()` loads it, unlocked. This is the seed of
the Holodeck: an example is exactly this shape.

### 1.5 Templates today

`utils/templates.ts` holds seven hand-placed built-in templates (Simple
Agent, Event-Driven Agent, Production Setup, Bedrock AI Agent, RAG Agent,
Multi-Agent Workflow, Async Processing Pipeline) as node and edge arrays
with coordinates, plus custom templates in `localStorage`
(`customTemplates`). `components/TemplateModal.tsx` opens from the toolbar
and the palette. No scenarios, no thumbnails, no attribution.

### 1.6 Known gaps that bear on this plan

- The CLI's deploy pipeline has no config-to-resources compiler yet
  (`UX_PLAN.md` step 0); Deploy plans zero changes. Unrelated to the
  Holodeck but worth knowing before promising "copy and deploy".
- Scenarios only model forward hops. There is no failed step, retry or
  branch, and dead-letter edges are folded into node config on import.
- Nodes have no free-text annotation for teaching callouts.
- Chrome MCP tabs are background-throttled: never use timers in tab
  scripts; page reloads wipe the store; reload the demo with
  `__warpcore.demo()`.

## 2. The Holodeck

A library of systems to load, walk through with scenarios, and copy to
work from. "Holodeck" is the name of the library and its drawer; the
simulation itself stays "scenarios", "playback" and the "system view".

### 2.1 Three families of entries

| Family | Examples | Fidelity tag |
|---|---|---|
| **AWS reference architectures** | Serverless web app (API Gateway, Lambda, DynamoDB, Cognito); event-driven order processing (EventBridge, SQS, SNS, Step Functions); static site (S3, CloudFront, Route 53, ACM); three-tier VPC app (ALB, ECS or EC2, RDS, ElastiCache); streaming analytics (Kinesis, Firehose, S3, Glue, Athena); RAG on Bedrock (S3, Lambda, OpenSearch or pgvector) | *reference*: AWS's published pattern |
| **In the style of well-known companies** | Slack message delivery; Netflix playback start; Airbnb search; Coinbase order flow; Duolingo lesson sync | *inspired by*: their public talk or post, with year. Never presented as the real system, no logos |
| **System design classics** | URL shortener, rate limiter, news feed, chat, notifications, video upload and streaming, ride matching, autocomplete, payments, flash-sale ticketing, file sync, web crawler, leaderboard | *textbook* |

Every entry ships with two to five scenarios, and every family after the
first includes at least one unhappy path: the cache miss, the retry into a
dead-letter queue, the fan-out that lags, the rate limit that trips. That
is what the simulator shows that a diagram cannot.

### 2.2 What an entry is

```yaml
# visual-builder/holodeck/url-shortener.yaml
holodeck:
  id: url-shortener
  name: URL shortener
  family: classic            # reference | inspired | classic
  summary: Redirects at the edge, writes behind an API, analytics off a stream.
  look_at:                   # what the entry is for; shown on the card and in the inspector
    - The read path never touches a function: CloudFront serves the redirect from the cache.
    - Clicks are counted asynchronously through Kinesis.
  source: { title: "...", url: "...", year: 2021 }   # inspired entries only
  difficulty: 1              # 1 to 3
project: { name: shortener, region: us-east-1 }
resources:                   # the AccountProject shape, no coordinates
  - { name: shortener-api, type: api-gateway, config: { apiName: shortener-api } }
  - { name: create-link, type: lambda, config: { functionName: create-link } }
  ...
connections:
  - { from: shortener-api, to: create-link, kind: invokes, detail: POST /links }
  - { from: create-link, to: links, kind: access, detail: read/write, via: create-role, actions: [dynamodb:PutItem] }
  ...
scenarios:
  - name: Create a short link
    trigger: { at: api-gateway-shortener-api, event: POST /links }
    steps: [...]
  - name: Redirect, cache miss
    ...
```

Authored **without coordinates**, by name rather than ARN (a loader
synthesises ARNs and ids the way `buildCanvas` does, so scenario step ids
are predictable: `lambda-create-link`). The layout comes from the stack
layout at load time, which is why entries are cheap to write and stay
consistent with imported accounts. Files live in `visual-builder/holodeck/`
and are bundled with `import.meta.glob`; the same files are readable by
the CLI later (`warpcore init --example url-shortener`).

### 2.3 The drawer

A drawer over the canvas (like the Account Explorer panel), opened from
the toolbar, the palette and the welcome screen. Two tabs:

- **Holodeck.** Cards by family, each with a rendered thumbnail (a small
  SVG of the stack tile from the layout, no screenshots to maintain), the
  services used, the scenario count, difficulty and the fidelity tag.
  Search across names, services and summaries.
- **Mine.** What `TemplateModal` holds today. The seven built-in templates
  migrate to Holodeck entries (they become better for it: laid out,
  with scenarios); custom templates stay in `localStorage` until the
  save-a-copy flow makes them project files.

Two actions per card:

- **Preview.** Load in memory, locked, no `configPath`, scenarios ready,
  the way `__warpcore.demo()` does. Play, switch lenses, open the system
  view. Closing the preview restores whatever was open (stash the store's
  project state first, or refuse when there are unsaved changes).
- **Save a copy.** Pick a folder, write `warpcore.yaml` (through the
  existing create-project path in `CreateProjectDialog.tsx`), open it
  unlocked, add it to recent projects. From there it is the user's.

While an entry is open, the project inspector shows its `look_at` notes
and source; the scenario inspector shows the step notes as it does now.

### 2.4 What has to grow

1. **Node types.** Cognito (user pool), OpenSearch, Aurora (as
   `rds-cluster`, exists), Glue, Athena, Fargate (as `ecs-service`,
   exists), WAF, DynamoDB Streams (as an edge kind, not a node). Added to
   `utils/discoveredTypes.ts` and the band table in `utils/stackLayout.ts`;
   the hop index needs nothing new for most of them.
2. **Failure paths in scenarios.** A step gains an optional `outcome:
   ok | fail | timeout` and an optional `retry: n`; a failing step
   pulses red, its retries replay the hop, and the dead-letter edge (kept
   as an edge on import, not folded into config) becomes a playable hop.
   `checkScenario` treats a `fail` step with no dead-letter or retry as a
   note, not a problem. Keep the model small.
3. **Annotations.** `meta.note` on a node: a small marker on the card and
   a paragraph in the inspector. Entries use it for the design decisions
   worth teaching. Saved with the project, so users can annotate their own.
4. **Thumbnails.** `utils/thumbnail.ts`: the stack layout drawn as an SVG
   string (bands as rectangles, cards as rounded rectangles, no text).
   Also useful for the recent-projects list later.

### 2.5 Order of work

| Step | What | Size |
|---|---|---|
| 1 | Entry format and loader (`utils/holodeck.ts`: parse, synthesise ids and ARNs, `buildCanvas`, scenarios; tests), three entries, one per family, including one unhappy path | 2 days |
| 2 | The drawer: cards, thumbnails, search, Preview, Save a copy; absorb the Templates dialog; welcome-screen entry point | 2 days |
| 3 | Failure-path step semantics and dead-letter edges kept on import | 2 days |
| 4 | Node types and annotations, as the content needs them | 1 to 2 days |
| 5 | Content: fifteen to twenty entries with scenarios, added incrementally; migrate the seven old templates | 3 to 5 days, can trail |

Steps 1 and 2 give a usable Holodeck with three entries. Steps 3 and 4
make the unhappy paths and the teaching notes possible; step 5 is the
library itself.

### 2.6 Decisions made

- Name: **Holodeck** for the library and drawer. Scenarios, playback and
  system view keep their names.
- Entries are authored in the account-project shape without coordinates,
  laid out at load, never hand-placed.
- Company-inspired entries are labelled as inspired by a cited public
  source, with the year, and carry no branding.
- Preview never writes a file; Save a copy always does, through the
  existing create-project path.

### 2.7 Open questions

- Should Preview be allowed with unsaved changes open (stash and restore)
  or refused until they are saved? Refusing is simpler and honest.
- Where do custom templates go long term: keep `localStorage`, or a
  `~/.warpcore/holodeck/` folder the CLI can also read? The folder is the
  better end state; not needed for step 2.
- Whether the CLI should ship the same entries (`warpcore init
  --example`). Cheap once the files exist; decide when step 5 is under way.
