// Adding a subnet to a VPC on the canvas, the way a table editor adds a
// column: a new partition appears at the right of the VPC, the VPC widens,
// and the subnet starts as a draft to be configured.

import { Node } from 'reactflow';
import { useStore } from '../store/useStore';
import { ADD_COLUMN_W, CELL_H, CELL_W, GROUP_GAP, GROUP_HEADER, GROUP_PAD, SUBNET_MIN_H } from './stackLayout';
import { orderParentsFirst } from './nodeTree';

const SUBNET_W = CELL_W + GROUP_PAD * 2;
const GAP = GROUP_GAP;
const PAD = GROUP_PAD;

export function addSubnet(vpcId: string): string | null {
  const { nodes, setNodes, selectNode } = useStore.getState();
  const vpc = nodes.find((n) => n.id === vpcId);
  if (!vpc) return null;
  const siblings = nodes.filter((n) => n.parentNode === vpcId && n.type === 'subnet');
  const others = nodes.filter((n) => n.parentNode === vpcId && n.type !== 'subnet');

  // Same row and height as the existing partitions; below the strip if none.
  const top = siblings.length
    ? Math.min(...siblings.map((s) => s.position.y))
    : (others.length ? Math.max(...others.map((o) => o.position.y + CELL_H)) + 24 : GROUP_HEADER);
  const height = siblings.length
    ? Math.max(...siblings.map((s) => Number(s.style?.height) || SUBNET_MIN_H))
    : Math.max(SUBNET_MIN_H, (Number(vpc.style?.height) || 260) - top - PAD);
  const left = siblings.length ? Math.max(...siblings.map((s) => s.position.x + (Number(s.style?.width) || SUBNET_W))) + GAP : PAD;

  let n = siblings.length + 1;
  let id = `subnet-new-${n}`;
  while (nodes.some((x) => x.id === id)) id = `subnet-new-${++n}`;

  const subnet: Node = {
    id,
    type: 'subnet',
    parentNode: vpcId,
    extent: 'parent',
    position: { x: left, y: top },
    style: { width: SUBNET_W, height },
    data: {
      label: `Subnet ${n}`,
      config: { name: `Subnet ${n}`, public: false },
      status: 'draft',
      region: vpc.data?.region,
      meta: { isGroup: true },
    },
  };

  const neededWidth = left + SUBNET_W + GAP + ADD_COLUMN_W + PAD;
  const neededHeight = top + height + PAD;
  const grown: Node = {
    ...vpc,
    style: {
      ...(vpc.style || {}),
      width: Math.max(Number(vpc.style?.width) || 0, neededWidth),
      height: Math.max(Number(vpc.style?.height) || 0, neededHeight),
    },
    data: { ...vpc.data, meta: { ...(vpc.data?.meta || {}), isGroup: true } },
  };

  setNodes(orderParentsFirst([...nodes.map((x) => (x.id === vpcId ? grown : x)), subnet]));
  selectNode(id);
  return id;
}
