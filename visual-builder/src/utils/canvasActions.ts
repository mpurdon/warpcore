// A small registry so things outside the React Flow tree - the command
// palette, the inspector, keyboard shortcuts - can move the viewport. The
// canvas registers its handlers on mount; everyone else calls these.

export interface CanvasHandlers {
  /** Fit the whole graph into view. */
  fitView: () => void;
  /** Pan and zoom so these nodes are comfortably in view. */
  fitToNodes: (ids: string[]) => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

let handlers: CanvasHandlers | null = null;

export function registerCanvas(h: CanvasHandlers | null): void {
  handlers = h;
}

export const canvas = {
  fitView: () => handlers?.fitView(),
  fitToNodes: (ids: string[]) => handlers?.fitToNodes(ids),
  zoomIn: () => handlers?.zoomIn(),
  zoomOut: () => handlers?.zoomOut(),
};
