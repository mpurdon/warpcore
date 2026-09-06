import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from 'reactflow';

vi.mock('reactflow', () => ({}));

import { _resetHistoryClock, selectionOnlyChange, useStore } from './useStore';

const node = (id: string, x = 0): Node => ({ id, type: 's3', position: { x, y: 0 }, data: { label: id } });

describe('selectionOnlyChange', () => {
  it('is true when only selected flags differ', () => {
    const a = [node('a'), node('b')];
    const b = [{ ...a[0], selected: true }, a[1]];
    expect(selectionOnlyChange(a, b)).toBe(true);
  });
  it('is false for a move, an add or a data change', () => {
    const a = [node('a'), node('b')];
    expect(selectionOnlyChange(a, [node('a', 10), a[1]])).toBe(false);
    expect(selectionOnlyChange(a, [...a, node('c')])).toBe(false);
    expect(selectionOnlyChange(a, [{ ...a[0], data: { label: 'renamed' } }, a[1]])).toBe(false);
  });
});

describe('undo / redo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    _resetHistoryClock();
    useStore.setState({ nodes: [], edges: [], past: [], future: [], hasUnsavedChanges: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('records a step per distinct change and undoes it', () => {
    useStore.getState().setNodes([node('a')]);
    later(1000);
    useStore.getState().setNodes([node('a'), node('b')]);
    expect(useStore.getState().past.length).toBe(2);

    useStore.getState().undo();
    expect(useStore.getState().nodes.map((n) => n.id)).toEqual(['a']);
    useStore.getState().undo();
    expect(useStore.getState().nodes).toEqual([]);
    useStore.getState().undo(); // nothing left: no-op
    expect(useStore.getState().nodes).toEqual([]);

    useStore.getState().redo();
    expect(useStore.getState().nodes.map((n) => n.id)).toEqual(['a']);
    expect(useStore.getState().future.length).toBe(1);
  });

  it('does not record selection-only changes, and does not dirty the project for them', () => {
    useStore.getState().setNodes([node('a')]);
    useStore.setState({ hasUnsavedChanges: false });
    later(1000);
    const before = useStore.getState().past.length;
    useStore.getState().setNodes((prev) => prev.map((n) => ({ ...n, selected: true })));
    expect(useStore.getState().past.length).toBe(before);
    expect(useStore.getState().hasUnsavedChanges).toBe(false);
  });

  it('folds a burst of changes into one step', () => {
    useStore.getState().setNodes([node('a')]);
    later(1000);
    // A drag: many position updates a frame apart.
    for (let x = 1; x <= 20; x++) {
      later(16);
      useStore.getState().setNodes([node('a', x)]);
    }
    expect(useStore.getState().past.length).toBe(2);
    useStore.getState().undo();
    // Back to before the drag began, not one frame back.
    expect(useStore.getState().nodes[0].position.x).toBe(0);
  });

  it('a new change after undo discards the redo stack', () => {
    useStore.getState().setNodes([node('a')]);
    later(1000);
    useStore.getState().setNodes([node('a'), node('b')]);
    useStore.getState().undo();
    expect(useStore.getState().future.length).toBe(1);
    later(1000);
    useStore.getState().setNodes([node('a'), node('c')]);
    expect(useStore.getState().future.length).toBe(0);
  });

  it('edge changes are steps too', () => {
    useStore.getState().setNodes([node('a'), node('b')]);
    later(1000);
    useStore.getState().setEdges([{ id: 'e', source: 'a', target: 'b' }]);
    expect(useStore.getState().past.length).toBe(2);
    useStore.getState().undo();
    expect(useStore.getState().edges).toEqual([]);
  });

  it('resetHistory forgets everything, as opening a project should', () => {
    useStore.getState().setNodes([node('a')]);
    useStore.getState().resetHistory();
    expect(useStore.getState().past).toEqual([]);
    expect(useStore.getState().future).toEqual([]);
  });
});
