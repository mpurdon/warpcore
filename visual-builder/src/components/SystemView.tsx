// The system view: the canvas as terraces, read-only, for presenting and
// for watching a scenario run. Bands are plates stepping down from entry
// to platform, resources are cards on them, edges are arcs between cards.
// It reads the same store as the canvas - the same lens re-flow, the same
// selection, the same playhead - so the two always show the same instant.
// Nothing here writes project state.

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Crosshair, RotateCcw } from 'lucide-react';
import { useStore } from '../store/useStore';
import { useLensView, useScenarioView } from '../hooks/useCanvasView';
import { CARD_H, Card, layoutSystem, Link, LinkKind, Slab, SystemLayout } from '../utils/systemLayout';
import { TRAVEL_MS } from '../utils/scenarios';

const LINK_COLOR: Record<LinkKind, number> = {
  flow: 0x8b5cf6, access: 0x3b82f6, logs: 0xf59e0b, structure: 0x9ca3af, drawn: 0x6b7280,
};
const LINK_OPACITY: Record<LinkKind, number> = { flow: 0.9, access: 0.85, logs: 0.6, structure: 0.3, drawn: 0.7 };
const BLUE = 0x2563eb;
const AMBER = 0xf59e0b;
const INK = 0x1f2937;

interface CardObject {
  card: Card;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  outline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  label: CSS2DObject;
  badge: HTMLSpanElement;
  nameEl: HTMLSpanElement;
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
  slabs: Map<string, THREE.Mesh>;
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

function buildScene(layout: SystemLayout): Built {
  const root = new THREE.Group();
  const cards = new Map<string, CardObject>();
  const links = new Map<string, LinkObject>();
  const slabs = new Map<string, THREE.Mesh>();

  for (const s of layout.slabs) {
    const geo = new THREE.BoxGeometry(s.w, s.t, s.d);
    const mat = new THREE.MeshStandardMaterial({ color: s.color, transparent: s.kind !== 'band', opacity: s.kind === 'band' ? 1 : 0.55, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.x, s.y, s.z);
    mesh.receiveShadow = true;
    mesh.userData = { slabId: s.id };
    root.add(mesh);
    slabs.set(s.id, mesh);
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
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(c.x, c.y + CARD_H / 2, c.z);
    mesh.castShadow = true;
    mesh.userData = { cardId: c.id };
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xd1d5db, transparent: true, opacity: 1 }));
    outline.position.copy(mesh.position);
    const el = document.createElement('div');
    el.className = `sv-card-label${c.compact ? ' sv-compact' : ''}`;
    const badge = document.createElement('span');
    badge.className = 'sv-badge';
    badge.hidden = true;
    const nameEl = document.createElement('span');
    nameEl.className = 'sv-name';
    nameEl.textContent = c.label;
    const typeEl = document.createElement('span');
    typeEl.className = 'sv-type';
    typeEl.textContent = c.type;
    el.append(badge, nameEl);
    if (!c.compact) el.append(typeEl);
    const label = new CSS2DObject(el);
    label.position.set(c.x, c.y + CARD_H + 0.02, c.z);
    label.center.set(0.5, 1);
    root.add(mesh, outline, label);
    cards.set(c.id, { card: c, mesh, outline, label, badge, nameEl });
  }

  for (const l of layout.links) {
    const from = cards.get(l.from)?.card;
    const to = cards.get(l.to)?.card;
    if (!from || !to) continue;
    const curve = makeCurve(from, to);
    const geo = new THREE.TubeGeometry(curve, 24, l.kind === 'structure' ? 0.01 : 0.016, 6, false);
    const mat = new THREE.MeshBasicMaterial({ color: LINK_COLOR[l.kind], transparent: true, opacity: LINK_OPACITY[l.kind] });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { linkId: l.id };
    root.add(mesh);
    links.set(l.id, { link: l, curve, mesh });
  }

  return { root, cards, links, slabs };
}

function disposeBuilt(b: Built): void {
  b.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
    if ((o as CSS2DObject).element) (o as CSS2DObject).element.remove();
  });
  b.root.removeFromParent();
}

export default function SystemView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const layers = useStore((s) => s.layers);
  const selectedNode = useStore((s) => s.selectedNode);
  const selectNode = useStore((s) => s.selectNode);
  const setSelectedNode = useStore((s) => s.setSelectedNode);
  const { reflow } = useLensView();
  const scenarioView = useScenarioView();
  const [follow, setFollow] = useState(true);

  // The scene lives outside React: one renderer, rebuilt geometry when the
  // layout changes, per-frame updates for the pulse and the camera.
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    labels: CSS2DRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    built: Built | null;
    pulse: { linkId: string; reverse: boolean; durationMs: number; startedAt: number; elapsedAtPause: number; playing: boolean } | null;
    logging: Set<string>;
    /** Where follow is taking the orbit target, and the camera with it. */
    target: { look: THREE.Vector3; eye: THREE.Vector3 } | null;
    fit: () => void;
    /** The camera has been framed once for this renderer. */
    fitted: boolean;
    raf: number;
  } | null>(null);

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
    scene.background = new THREE.Color(0xf3f4f6);
    scene.fog = new THREE.Fog(0xf3f4f6, 18, 40);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 1.5;
    controls.maxDistance = 40;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd1d5db, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(6, 12, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -14; sun.shadow.camera.right = 14; sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const state = {
      renderer, labels, scene, camera, controls, built: null as Built | null, pulse: null as typeof sceneRef.current extends infer T ? T extends { pulse: infer P } ? P : never : never,
      logging: new Set<string>(), target: null as { look: THREE.Vector3; eye: THREE.Vector3 } | null, fit: () => {}, fitted: false, raf: 0,
    };
    sceneRef.current = state as NonNullable<typeof sceneRef.current>;
    if (import.meta.env.DEV) (window as unknown as { __systemView?: unknown }).__systemView = state;

    // Click without drag selects; drag orbits.
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
      down = null;
      const b = sceneRef.current?.built;
      if (!b) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects([...b.cards.values()].map((c) => c.mesh), false)[0];
      const s = useStore.getState();
      if (hit) {
        const id = String(hit.object.userData.cardId);
        if (s.recording && s.inspectedScenario) s.recordStep(id);
        else selectNode(id);
      } else if (!s.recording) {
        setSelectedNode(null);
        s.setNodes(s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)));
      }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    const clock = new THREE.Clock();
    const tick = () => {
      const st = sceneRef.current;
      if (!st) return;
      st.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, clock.getDelta());
      const now = performance.now();
      // The pulse: where the request is along its hop.
      if (st.pulse && st.built) {
        const lo = st.built.links.get(st.pulse.linkId);
        const elapsed = st.pulse.playing ? now - st.pulse.startedAt : st.pulse.elapsedAtPause;
        const t = Math.min(1, elapsed / st.pulse.durationMs);
        const sphere = st.scene.getObjectByName('pulse') as THREE.Mesh | undefined;
        if (lo && sphere) {
          const p = lo.curve.getPointAt(st.pulse.reverse ? 1 - t : t);
          sphere.position.copy(p);
          sphere.visible = true;
        }
      } else {
        const sphere = st.scene.getObjectByName('pulse') as THREE.Mesh | undefined;
        if (sphere) sphere.visible = false;
      }
      // Log groups flicker while written to.
      if (st.built && st.logging.size) {
        for (const id of st.logging) {
          const c = st.built.cards.get(id);
          if (c) c.mesh.material.emissiveIntensity = 0.35 + 0.35 * Math.abs(Math.sin(now / 90));
        }
      }
      // Follow: pan towards the request, keeping the viewing direction.
      if (st.target) {
        const k = Math.min(1, dt * 4);
        st.controls.target.lerp(st.target.look, k);
        st.camera.position.lerp(st.target.eye, k);
        if (st.controls.target.distanceTo(st.target.look) < 0.01) st.target = null;
      }
      st.controls.update();
      st.renderer.render(st.scene, st.camera);
      st.labels.render(st.scene, st.camera);
    };
    const pulseSphere = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), new THREE.MeshStandardMaterial({ color: BLUE, emissive: BLUE, emissiveIntensity: 0.8 }));
    pulseSphere.name = 'pulse';
    pulseSphere.visible = false;
    scene.add(pulseSphere);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.18 }));
    pulseSphere.add(halo);
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
  }, [selectNode, setSelectedNode]);

  // Rebuild the geometry when the layout changes. The first build for a
  // renderer also frames the camera; later ones keep the operator's
  // viewpoint. (The flag lives on the renderer state, not in a React ref:
  // StrictMode mounts twice, and the second renderer must be framed too.)
  useEffect(() => {
    const st = sceneRef.current;
    if (!st) return;
    const layout = layoutSystem(nodes, edges, reflow ?? {});
    if (st.built) disposeBuilt(st.built);
    st.built = buildScene(layout);
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
    };
    if (!st.fitted) { st.fit(); st.fitted = true; }
  }, [nodes, edges, reflow]);

  // Decorate: edge layers, selection, and the scenario at the playhead.
  useEffect(() => {
    const st = sceneRef.current;
    const b = st?.built;
    if (!st || !b) return;
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
      mat.color.set(0xffffff);
      mat.emissive.set(0x000000);
      mat.emissiveIntensity = 0;
      mat.opacity = playing && !involved ? 0.25 : 1;
      c.outline.material.color.set(selected ? BLUE : state === 'visited' || state === 'active' ? INK : 0xd1d5db);
      c.outline.material.opacity = mat.opacity;
      c.label.element.classList.toggle('sv-dim', playing && !involved);
      c.label.element.classList.toggle('sv-selected', selected);
      let lift = 0;
      if (state === 'active') { mat.emissive.set(BLUE); mat.emissiveIntensity = 0.55; lift = 0.18; }
      else if (state === 'travelling') { mat.emissive.set(BLUE); mat.emissiveIntensity = 0.2; }
      if (logging) { mat.emissive.set(AMBER); mat.emissiveIntensity = 0.5; }
      const y = c.card.y + CARD_H / 2 + lift;
      c.mesh.position.y = y;
      c.outline.position.y = y;
      c.label.position.y = c.card.y + CARD_H + 0.02 + lift;
      if (numbers?.length) {
        c.badge.hidden = false;
        c.badge.textContent = numbers.map((n) => (n === 0 ? '▶' : String(n))).join(' ');
        c.badge.className = `sv-badge ${state === 'active' ? 'sv-badge-active' : state === 'pending' || state === 'travelling' ? 'sv-badge-pending' : ''}`;
      } else {
        c.badge.hidden = true;
      }
    }
    st.logging = new Set(sv?.marks.logging ?? []);
    for (const [id, l] of b.links) {
      const edge = edges.find((e) => e.id === id);
      const layer = edge?.data?.meta?.layer as keyof typeof layers | undefined;
      const onPath = sv?.pathEdges.has(id) ?? false;
      const isLog = sv?.logEdges.has(id) ?? false;
      const layerOn = !layer || layers[layer];
      const touchesSelection = selectedNode !== null && (edge?.source === selectedNode || edge?.target === selectedNode);
      const visible = layerOn || touchesSelection || onPath || isLog;
      l.mesh.visible = visible;
      const base = LINK_OPACITY[l.link.kind];
      l.mesh.material.opacity = !layerOn && !onPath && !isLog ? base * 0.35 : playing && !onPath && !isLog ? base * 0.15 : base;
      l.mesh.material.color.set(sv?.marks.logEdges.has(id) ? AMBER : LINK_COLOR[l.link.kind]);
      l.mesh.scale.setScalar(1);
    }
    // The pulse.
    const pulse = sv?.marks.pulse ?? null;
    if (pulse && head) {
      const durationMs = TRAVEL_MS / (head.speed || 1);
      const prev = st.pulse;
      if (!prev || prev.linkId !== pulse.edgeId || prev.reverse !== pulse.reverse) {
        st.pulse = { linkId: pulse.edgeId, reverse: pulse.reverse, durationMs, startedAt: performance.now(), elapsedAtPause: 0, playing: head.playing };
      } else if (prev.playing !== head.playing) {
        // Pause freezes the elapsed time; resume continues from it.
        const elapsed = prev.playing ? performance.now() - prev.startedAt : prev.elapsedAtPause;
        st.pulse = { ...prev, durationMs, playing: head.playing, elapsedAtPause: elapsed, startedAt: performance.now() - elapsed };
      }
    } else {
      st.pulse = null;
    }
    // Follow the request.
    if (follow && sv && head && head.phase !== 'end') {
      const at = head.phase === 'travel' ? sv.check.steps[head.index]?.evidence?.from : head.index < 0 ? sv.scenario.trigger.at : sv.scenario.steps[head.index]?.at;
      const to = head.phase === 'travel' ? sv.scenario.steps[head.index]?.at : undefined;
      const a = at ? b.cards.get(at) : undefined;
      const c2 = to ? b.cards.get(to) : undefined;
      if (a) {
        const look = cardTop(a.card);
        if (c2) look.add(cardTop(c2.card)).multiplyScalar(0.5);
        const shift = look.clone().sub(st.controls.target);
        st.target = { look, eye: st.camera.position.clone().add(shift) };
      }
    }
  }, [scenarioView, selectedNode, layers, edges, follow, nodes]);

  const stackEmpty = nodes.filter((n) => !n.hidden).length === 0;

  return (
    <div className="absolute inset-0 z-10 bg-gray-100" aria-label="System view">
      <div ref={hostRef} className="absolute inset-0 sv-host" />
      {stackEmpty && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 pointer-events-none">Nothing on the canvas to show.</div>
      )}
      <div className="absolute right-3 z-20 flex items-center gap-1 text-xs" style={{ top: 12 }}>
        <span className="px-2 py-1 rounded-md bg-white/90 border border-gray-200 text-gray-600 shadow-sm" title="Drag to orbit, scroll to zoom, right-drag to pan. Click a card to inspect it.">
          System view · read only
        </span>
        <button
          onClick={() => setFollow((f) => !f)}
          className={`px-2 py-1 rounded-md bg-white/90 border border-gray-200 shadow-sm inline-flex items-center gap-1 ${follow ? 'text-blue-700' : 'text-gray-600'}`}
          title={follow ? 'Following the request' : 'Follow the request as it plays'}
        >
          <Crosshair size={12} /> Follow
        </button>
        <button
          onClick={() => sceneRef.current?.fit()}
          className="px-2 py-1 rounded-md bg-white/90 border border-gray-200 shadow-sm inline-flex items-center gap-1 text-gray-600"
          title="Reset the camera"
        >
          <RotateCcw size={12} /> Reset
        </button>
      </div>
    </div>
  );
}

export { LINK_COLOR };
export type { Slab };
