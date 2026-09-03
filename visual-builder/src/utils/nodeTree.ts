// React Flow renders a group before its children, so any list of nodes
// handed to it must be ordered by nesting depth. Everything that produces a
// node list (parsing a file, building from an account, adding a subnet)
// goes through this.

import { Node } from 'reactflow';

export function orderParentsFirst(nodes: Node[]): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const depthOf = (n: Node): number => {
    const cached = depth.get(n.id);
    if (cached !== undefined) return cached;
    const parent = n.parentNode ? byId.get(n.parentNode) : undefined;
    const d = parent ? depthOf(parent) + 1 : 0;
    depth.set(n.id, d);
    return d;
  };
  return [...nodes].sort((a, b) => depthOf(a) - depthOf(b));
}
