// The system view: the canvas as terraces, read-only, for presenting and
// for watching a scenario run. Bands are plates stepping down from entry
// to platform, resources are cards on them, edges are arcs between cards.
// It reads the same store as the canvas - the same lens re-flow, the same
// selection, the same playhead - so the two always show the same instant.
// Nothing here writes project state.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RotateCcw } from 'lucide-react';
import { useStore } from '../store/useStore';
import { edgeView, useScenarioView } from '../hooks/useCanvasView';
import { CARD_H, Card, layoutSystem, Link, LinkKind, SystemLayout } from '../utils/systemLayout';
import { badgeLabel, badgeTone } from '../utils/scenarios';
import type { Reflow } from '../utils/stackLayout';
import { cssColorHex, useThemeVersion } from '../utils/theme';

// Colours come from the theme tokens at build time, so the terraces follow
// the appearance; a theme change rebuilds the scene (see themeVersion).
const LINK_TOKEN: Record<LinkKind, string> = { flow: 'violet-500', access: 'blue-500', logs: 'amber-500', structure: 'gray-400', drawn: 'gray-500' };
/** The view's colours, read once per pass (cssColorHex caches per theme). */
function palette() {
  return {
    surface: cssColorHex('surface'), edge: cssColorHex('gray-300'), ground: cssColorHex('gray-100'),
    blue: cssColorHex('blue-600'), amber: cssColorHex('amber-500'), red: cssColorHex('red-600'), ink: cssColorHex('gray-800'),
    link: Object.fromEntries(Object.entries(LINK_TOKEN).map(([k, t]) => [k, cssColorHex(t)])) as Record<LinkKind, number>,
  };
}
type Palette = ReturnType<typeof palette>;

function paintGround(scene: THREE.Scene, pal: Palette): void {
  scene.background = new THREE.Color(pal.ground);
  scene.fog = new THREE.Fog(pal.ground, 18, 40);
}
const LINK_OPACITY: Record<LinkKind, number> = { flow: 0.9, access: 0.85, logs: 0.6, structure: 0.3, drawn: 0.7 };
/** How far a link fades for each emphasis, as a factor of its own opacity. */
const EMPHASIS_FACTOR = { normal: 1, dimmed: 0.35, background: 0.15 } as const;
const EMPTY: ReadonlySet<string> = new Set();

interface CardObject {
  card: Card;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  outline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  label: CSS2DObject;
  badge: HTMLSpanElement;
}

interface LinkObject {
  link: Link;
  curve: THREE.QuadraticBezierCurve3;
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
}

interface Built {
  root: THREE.Group;
  cards: Map<string, CardObject>;
  links: Map<string, LinkObject>;
  /** The bands and sheets, with the token each paints, so a theme change can recolour them. */
  slabs: { mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>; token: string }[];
}

/** The request travelling a hop: which link, which way, and its clock. */
interface Pulse {
  linkId: string;
  reverse: boolean;
  /** Which attempt crosses; a retry re-crosses the same link. */
  attempt: number;
  durationMs: number;
  startedAt: number;
  /** Set while paused; the elapsed time is frozen at pausedAt - startedAt. */
  pausedAt: number | null;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  pulseMesh: THREE.Mesh;
  built: Built | null;
  pulse: Pulse | null;
  logging: ReadonlySet<string>;
  /** Where follow is taking the orbit target, and the camera with it. */
  target: { look: THREE.Vector3; eye: THREE.Vector3 } | null;
  fit: () => void;
  /** The camera has been framed once for this renderer. */
  fitted: boolean;
  /** Something changed that the next frame must draw. */
  dirty: boolean;
  raf: number;
}

function cardTop(c: Card): THREE.Vector3 {
  return new THREE.Vector3(c.x, c.y + CARD_H, c.z);
}

function makeCurve(from: Card, to: Card): THREE.QuadraticBezierCurve3 {
  const a = cardTop(from);
  const b = cardTop(to);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dist = a.distanceTo(b);
  mid.y = Math.max(a.y, b.y) + 0.35 + dist * 0.18;
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}

function buildScene(layout: SystemLayout, pal: Palette): Built {
  const root = new THREE.Group();
  const cards = new Map<string, CardObject>();
  const links = new Map<string, LinkObject>();
  const slabs: Built['slabs'] = [];

  for (const s of layout.slabs) {
    const geo = new THREE.BoxGeometry(s.w, s.t, s.d);
    const mat = new THREE.MeshStandardMaterial({ color: cssColorHex(s.color), transparent: s.kind !== 'band', opacity: s.kind === 'band' ? 1 : 0.55, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.x, s.y, s.z);
    mesh.receiveShadow = true;
    root.add(mesh);
    slabs.push({ mesh, token: s.color });
    if (s.label) {
      const el = document.createElement('div');
      el.className = `sv-slab-label sv-slab-${s.kind}`;
      el.textContent = s.label;
      const label = new CSS2DObject(el);
      label.position.set(s.x - s.w / 2 + 0.05, s.y + s.t / 2 + 0.02, s.z - s.d / 2 + 0.05);
      label.center.set(0, 1);
      root.add(label);
    }
  }

  for (const c of layout.captions) {
    const el = document.createElement('div');
    el.className = 'sv-caption';
    el.textContent = c.text;
    const label = new CSS2DObject(el);
    label.position.set(c.x, c.y, c.z);
    label.center.set(0, 1);
    root.add(label);
  }

  for (const c of layout.cards) {
    const geo = new THREE.BoxGeometry(c.w, CARD_H, c.d);
    const mat = new THREE.MeshStandardMaterial({ color: pal.surface, roughness: 0.6, metalness: 0, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(c.x, c.y + CARD_H / 2, c.z);
    mesh.castShadow = true;
    mesh.userData = { cardId: c.id };
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: pal.edge, transparent: true, opacity: 1 }));
    outline.position.copy(mesh.position);
    const el = document.createElement('div');
    el.className = `sv-card-label${c.compact ? ' sv-compact' : ''}`;
    const badge = document.createElement('span');
    badge.className = 'scn-badge';
    badge.hidden = true;
    const nameEl = document.createElement('span');
    nameEl.className = 'sv-name';
    nameEl.textContent = c.label;
    el.append(badge, nameEl);
    if (!c.compact) {
      const typeEl = document.createElement('span');
      typeEl.className = 'sv-type';
      typeEl.textContent = c.type;
      el.append(typeEl);
    }
    const label = new CSS2DObject(el);
    label.position.set(c.x, c.y + CARD_H + 0.02, c.z);
    label.center.set(0.5, 1);
    root.add(mesh, outline, label);
    cards.set(c.id, { card: c, mesh, outline, label, badge });
  }

  for (const l of layout.links) {
    const from = cards.get(l.from)?.card;
    const to = cards.get(l.to)?.card;
    if (!from || !to) continue;
    const curve = makeCurve(from, to);
    const geo = new THREE.TubeGeometry(curve, 24, l.kind === 'structure' ? 0.01 : 0.016, 6, false);
    const mat = new THREE.MeshBasicMaterial({ color: pal.link[l.kind], transparent: true, opacity: LINK_OPACITY[l.kind] });
    const mesh = new THREE.Mesh(geo, mat);
    root.add(mesh);
    links.set(l.id, { link: l, curve, mesh });
  }

  return { root, cards, links, slabs };
}

function disposeBuilt(b: Built): void {
  b.root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
    (o as CSS2DObject).element?.remove();
  });
  b.root.removeFromParent();
}

/** What has to be equal for the built scene to be reusable: every placement, nothing about state. */
function layoutKey(layout: SystemLayout): string {
  const r = (v: number) => Math.round(v * 1000);
  return [
    ...layout.slabs.map((s) => `s${s.id}:${r(s.x)},${r(s.y)},${r(s.z)},${r(s.w)},${r(s.d)},${s.kind}`),
    ...layout.cards.map((c) => `c${c.id}:${r(c.x)},${r(c.y)},${r(c.z)},${r(c.w)},${r(c.d)},${c.label}`),
    ...layout.links.map((l) => `l${l.id}:${l.kind}`),
    ...layout.captions.map((c) => `t${c.id}:${c.text}`),
  ].join('|');
}

export default function SystemView({ reflow }: { reflow: Reflow | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const themeVersion = useThemeVersion();
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const layers = useStore((s) => s.layers);
  const selectedNode = useStore((s) => s.selectedNode);
  const selectNode = useStore((s) => s.selectNode);
  const deselectAll = useStore((s) => s.deselectAll);
  const recordStep = useStore((s) => s.recordStep);
  const follow = useStore((s) => s.followPlayhead);
  const scenarioView = useScenarioView();

  // The scene lives outside React: one renderer, geometry rebuilt when a
  // placement changes, per-frame work only for the pulse and the camera.
  const sceneRef = useRef<SceneState | null>(null);

  // Mount the renderer once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = 'sv-canvas';
    host.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'sv-labels';
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    paintGround(scene, palette());
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 1.5;
    controls.maxDistance = 40;

    scene.add(new THREE.HemisphereLight(0xffffff, cssColorHex('gray-300'), 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(6, 12, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -14; sun.shadow.camera.right = 14; sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    const pulseBlue = palette().blue;
    const pulseMesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), new THREE.MeshStandardMaterial({ color: pulseBlue, emissive: pulseBlue, emissiveIntensity: 0.8 }));
    pulseMesh.visible = false;
    pulseMesh.add(new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), new THREE.MeshBasicMaterial({ color: pulseBlue, transparent: true, opacity: 0.18 })));
    scene.add(pulseMesh);

    const state: SceneState = {
      renderer, labels, scene, camera, controls, pulseMesh, built: null, pulse: null, logging: EMPTY, target: null,
      fit: () => {}, fitted: false, dirty: true, raf: 0,
    };
    sceneRef.current = state;
    if (import.meta.env.DEV) {
      const dev = (window as unknown as { __warpcore?: Record<string, unknown> }).__warpcore;
      if (dev) dev.systemView = state;
    }

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      state.dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    controls.addEventListener('change', () => { state.dirty = true; });

    // Click without drag selects; drag orbits.
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
      down = null;
      const b = state.built;
      if (!b) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects([...b.cards.values()].map((c) => c.mesh), false)[0];
      const recording = useStore.getState().recording;
      if (hit) {
        const id = String(hit.object.userData.cardId);
        if (recording) recordStep(id);
        else selectNode(id);
      } else if (!recording) {
        deselectAll();
      }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    // Frames are drawn on demand: when something changed, while the camera
    // is still settling, and while a pulse, a ticker or a follow is live.
    const clock = new THREE.Clock();
    const tick = () => {
      state.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, clock.getDelta());
      const now = performance.now();
      let live = false;
      const lo = state.pulse && state.built ? state.built.links.get(state.pulse.linkId) : undefined;
      if (state.pulse && lo) {
        const elapsed = (state.pulse.pausedAt ?? now) - state.pulse.startedAt;
        const t = Math.min(1, elapsed / state.pulse.durationMs);
        lo.curve.getPointAt(state.pulse.reverse ? 1 - t : t, pulseMesh.position);
        pulseMesh.visible = true;
        live = t < 1 && state.pulse.pausedAt === null;
      } else {
        pulseMesh.visible = false;
      }
      if (state.built && state.logging.size) {
        for (const id of state.logging) {
          const c = state.built.cards.get(id);
          if (c) c.mesh.material.emissiveIntensity = 0.35 + 0.35 * Math.abs(Math.sin(now / 90));
        }
        live = true;
      }
      if (state.target) {
        const k = Math.min(1, dt * 4);
        controls.target.lerp(state.target.look, k);
        camera.position.lerp(state.target.eye, k);
        if (controls.target.distanceTo(state.target.look) < 0.01) state.target = null;
        live = true;
      }
      const moved = controls.update();
      if (state.dirty || moved || live) {
        renderer.render(scene, camera);
        labels.render(scene, camera);
        state.dirty = false;
      }
    };
    state.raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose();
      if (state.built) disposeBuilt(state.built);
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
      sceneRef.current = null;
    };
  }, [selectNode, deselectAll, recordStep]);

  // The geometry is rebuilt only when a placement changes, not when a node
  // is selected (selection rewrites the nodes array too).
  const layout = useMemo(() => layoutSystem(nodes, edges, reflow ?? {}), [nodes, edges, reflow]);
  const key = useMemo(() => layoutKey(layout), [layout]);
  // The theme's colours: the ground, and the slabs baked when the scene was
  // built. Everything else is re-coloured by the decorate pass below.
  useEffect(() => {
    const st = sceneRef.current;
    if (!st?.built) return;
    const pal = palette();
    paintGround(st.scene, pal);
    for (const slab of st.built.slabs) slab.mesh.material.color.set(cssColorHex(slab.token));
  }, [themeVersion, key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const st = sceneRef.current;
    if (!st) return;
    if (st.built) disposeBuilt(st.built);
    st.built = buildScene(layout, palette());
    st.scene.add(st.built.root);
    const b = layout.bounds;
    st.fit = () => {
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 2);
      st.controls.target.set(cx, (b.minY + b.maxY) / 2, cz);
      st.camera.position.set(cx + span * 0.35, b.maxY + span * 0.75, cz + span * 1.05);
      st.target = null;
      st.controls.update();
      st.dirty = true;
    };
    // The first build for a renderer frames the camera; later ones keep the
    // operator's viewpoint. The flag lives on the renderer state, not in a
    // React ref: StrictMode mounts twice, and the second renderer must be
    // framed too.
    if (!st.fitted) { st.fit(); st.fitted = true; }
    st.dirty = true;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Decorate: edge layers, selection, and the scenario at the playhead.
  useEffect(() => {
    const st = sceneRef.current;
    const b = st?.built;
    if (!st || !b) return;
    const pal = palette();
    const sv = scenarioView;
    const head = sv?.head ?? null;
    const playing = Boolean(head);
    for (const [id, c] of b.cards) {
      const numbers = sv?.marks.numbers.get(id);
      const state = sv?.marks.state.get(id);
      const logging = sv?.marks.logging.has(id) ?? false;
      const involved = Boolean(numbers?.length) || logging;
      const selected = id === selectedNode;
      const mat = c.mesh.material;
      mat.color.set(pal.surface);
      mat.emissive.set(0x000000);
      mat.emissiveIntensity = 0;
      mat.opacity = playing && !involved ? 0.25 : 1;
      c.outline.material.color.set(selected ? pal.blue : state === 'failed' || state === 'failing' ? pal.red : state === 'visited' || state === 'active' ? pal.ink : pal.edge);
      c.outline.material.opacity = mat.opacity;
      c.label.element.classList.toggle('sv-dim', playing && !involved);
      c.label.element.classList.toggle('sv-selected', selected);
      let lift = 0;
      if (state === 'active') { mat.emissive.set(pal.blue); mat.emissiveIntensity = 0.55; lift = 0.18; }
      else if (state === 'failing') { mat.emissive.set(pal.red); mat.emissiveIntensity = 0.6; lift = 0.18; }
      else if (state === 'travelling') { mat.emissive.set(pal.blue); mat.emissiveIntensity = 0.2; }
      if (logging) { mat.emissive.set(pal.amber); mat.emissiveIntensity = 0.5; }
      const y = c.card.y + CARD_H / 2 + lift;
      c.mesh.position.y = y;
      c.outline.position.y = y;
      c.label.position.y = c.card.y + CARD_H + 0.02 + lift;
      c.badge.hidden = !numbers?.length;
      if (numbers?.length) {
        c.badge.textContent = numbers.map(badgeLabel).join(' ');
        c.badge.className = `scn-badge ${badgeTone(state)}`;
      }
    }
    st.logging = sv?.marks.logging ?? EMPTY;
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    let pulseView: { edgeId: string; reverse: boolean; durationMs: number; attempt: number } | null = null;
    for (const [id, l] of b.links) {
      const edge = edgeById.get(id);
      const view = edge ? edgeView(edge, layers, selectedNode, sv) : null;
      l.mesh.visible = view?.visible ?? true;
      l.mesh.material.opacity = LINK_OPACITY[l.link.kind] * EMPHASIS_FACTOR[view?.emphasis ?? 'normal'] * (view?.ahead ? 0.5 : 1);
      l.mesh.material.color.set(view?.logging ? pal.amber : pal.link[l.link.kind]);
      if (view?.pulse) pulseView = { edgeId: id, reverse: view.pulse.reverse, durationMs: view.pulse.durationMs, attempt: view.pulse.attempt };
    }
    // The pulse: start its clock when the hop changes, freeze it on pause.
    if (pulseView && head) {
      const prev = st.pulse;
      const now = performance.now();
      if (!prev || prev.linkId !== pulseView.edgeId || prev.reverse !== pulseView.reverse || prev.attempt !== pulseView.attempt) {
        st.pulse = { linkId: pulseView.edgeId, reverse: pulseView.reverse, attempt: pulseView.attempt, durationMs: pulseView.durationMs, startedAt: now, pausedAt: head.playing ? null : now };
      } else if (head.playing && prev.pausedAt !== null) {
        st.pulse = { ...prev, durationMs: pulseView.durationMs, startedAt: now - (prev.pausedAt - prev.startedAt), pausedAt: null };
      } else if (!head.playing && prev.pausedAt === null) {
        st.pulse = { ...prev, durationMs: pulseView.durationMs, pausedAt: now };
      }
    } else {
      st.pulse = null;
    }
    // Follow the request: pan the camera with it.
    if (follow && sv?.focus) {
      const a = b.cards.get(sv.focus.at);
      const f = sv.focus.from ? b.cards.get(sv.focus.from) : undefined;
      if (a) {
        const look = cardTop(a.card);
        if (f && head?.phase === 'travel') look.add(cardTop(f.card)).multiplyScalar(0.5);
        const shift = look.clone().sub(st.controls.target);
        st.target = { look, eye: st.camera.position.clone().add(shift) };
      }
    }
    st.dirty = true;
  }, [scenarioView, selectedNode, layers, edges, follow, key, themeVersion]);

  const empty = !nodes.some((n) => !n.hidden);

  return (
    <div className="absolute inset-0 z-10 bg-gray-100" aria-label="System view">
      <div ref={hostRef} className="absolute inset-0 sv-host" />
      {empty && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 pointer-events-none">Nothing on the canvas to show.</div>
      )}
      <div className="absolute right-3 z-20 flex items-center gap-1 text-xs" style={{ top: 12 }}>
        <span className="px-2 py-1 rounded-md bg-surface/90 border border-gray-200 text-gray-600 shadow-sm" title="Drag to orbit, scroll to zoom, right-drag to pan. Click a card to inspect it.">
          System view · read only
        </span>
        <button
          onClick={() => sceneRef.current?.fit()}
          className="px-2 py-1 rounded-md bg-surface/90 border border-gray-200 shadow-sm inline-flex items-center gap-1 text-gray-600"
          title="Reset the camera"
        >
          <RotateCcw size={12} /> Reset
        </button>
      </div>
    </div>
  );
}
