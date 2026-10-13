// Laying the canvas out: the arrangement an imported account gets, on
// demand, for a canvas built by hand or by commands.

import { useStore } from '../store/useStore';
import { layoutCanvas } from '../utils/autoLayout';
import { canvas } from '../utils/canvasActions';
import { define } from './registry';

define({
  id: 'canvas.layout', title: 'Lay out the canvas', description: "Arrange the canvas the way an import does: resources clustered into application tiles, each tile's members in bands in request order (entry, compute, bus, data, platform), the whole thing stacked. Containment that already means something, a VPC and what sits in it, is kept.", group: 'Canvas', kind: 'project',
  keywords: ['arrange', 'tidy', 'organise', 'organize', 'tiles', 'bands', 'auto'],
  available: (s) => (s.nodes.length ? null : 'Nothing on the canvas yet'),
  describe: (_a, s) => `Lay out ${s.nodes.filter((n) => !['application', 'band'].includes(n.type || '')).length} resources`,
  run: (_a, { state }) => {
    const laid = layoutCanvas(state.nodes, state.edges, { projectName: state.projectName ?? undefined });
    useStore.getState().setNodes(laid);
    // The edges were given handles in place; hand React Flow the same array back so it redraws them.
    useStore.getState().setEdges((edges) => [...edges]);
    setTimeout(() => canvas.fitView(), 60);
    return { nodes: laid.length, tiles: laid.filter((n) => n.type === 'application').length, bands: laid.filter((n) => n.type === 'band').length };
  },
});
