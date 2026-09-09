// Custom templates: what the operator saved from the canvas, kept in
// localStorage. The built-in starters moved to the Holodeck
// (visual-builder/holodeck/*.yaml), where they are laid out and carry
// scenarios; see utils/holodeck.ts.

import { Node, Edge } from 'reactflow';

export interface Template {
  id: string;
  name: string;
  description: string;
  category: 'starter' | 'production' | 'ai-ml' | 'custom';
  nodes: Node[];
  edges: Edge[];
}

export function saveCustomTemplate(name: string, description: string, nodes: Node[], edges: Edge[]): Template {
  const template: Template = {
    id: `custom-${Date.now()}`,
    name,
    description,
    category: 'custom',
    nodes: nodes.map(node => ({
      ...node,
      data: { ...node.data, status: 'draft' },
    })),
    edges,
  };

  // In a real app, save to local storage or backend
  const customTemplates = JSON.parse(localStorage.getItem('customTemplates') || '[]');
  customTemplates.push(template);
  localStorage.setItem('customTemplates', JSON.stringify(customTemplates));

  return template;
}

export function loadCustomTemplates(): Template[] {
  try {
    return JSON.parse(localStorage.getItem('customTemplates') || '[]');
  } catch {
    return [];
  }
}

export function deleteCustomTemplate(templateId: string): void {
  const customTemplates = loadCustomTemplates();
  const filtered = customTemplates.filter(t => t.id !== templateId);
  localStorage.setItem('customTemplates', JSON.stringify(filtered));
}

export function applyTemplate(template: Template): { nodes: Node[]; edges: Edge[] } {
  // Generate new IDs to avoid conflicts
  const idMap = new Map<string, string>();
  const timestamp = Date.now();

  const nodes = template.nodes.map((node, index) => {
    const newId = `${node.type}-${timestamp}-${index}`;
    idMap.set(node.id, newId);
    return {
      ...node,
      id: newId,
      data: { ...node.data, status: 'draft' },
    };
  });

  const edges = template.edges.map((edge, index) => ({
    ...edge,
    id: `edge-${timestamp}-${index}`,
    source: idMap.get(edge.source) || edge.source,
    target: idMap.get(edge.target) || edge.target,
  }));

  return { nodes, edges };
}
