// Laying the canvas out: the arrangement an imported account gets, on
// demand, for a canvas built by hand or by commands.

import { useStore } from '../store/useStore';
import { LAYOUT_CONTAINERS, layoutCanvas } from '../utils/autoLayout';
import { define } from './registry';

define({
  id: 'canvas.layout', title: 'Lay out the canvas', description: "Arrange the canvas the way an import does: resources clustered into application tiles, each tile's members in bands in request order (entry, compute, bus, data, platform), the whole thing stacked. Containment that already means something, a VPC and what sits in it, is kept.", group: 'Canvas', kind: 'project',
  keywords: ['arrange', 'tidy', 'organise', 'organize', 'tiles', 'bands', 'auto'],
  available: (s) => (s.nodes.length ? null : 'Nothing on the canvas yet'),
  describe: (_a, s) => `Lay out ${s.nodes.filter((n) => !LAYOUT_CONTAINERS.has(n.type || '')).length} resources`,
  run: (_a, { state }) => {
    const laid = layoutCanvas(state.nodes, state.edges, { projectName: state.projectName ?? undefined });
    const s = useStore.getState();
    s.setNodes(laid);
    // The edges were given handles in place; hand React Flow the same array back so it redraws them.
    s.setEdges((edges) => [...edges]);
    // Fit once React Flow has measured the new tiles, the way a freshly
    // opened project does; a timer here would race the measurement.
    s.fitWhenMeasured();
    return { nodes: laid.length, tiles: laid.filter((n) => n.type === 'application').length, bands: laid.filter((n) => n.type === 'band').length };
  },
});
