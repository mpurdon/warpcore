import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYERS, layersToReveal } from './layers';

describe('layersToReveal', () => {
  it('switches on the layers an account has when none of the visible ones carry an edge', () => {
    expect(layersToReveal(['network', 'network', 'plumbing', undefined], DEFAULT_LAYERS)).toEqual(['network', 'plumbing']);
  });
  it('leaves the layers alone when something is already showing', () => {
    expect(layersToReveal(['network', 'access'], DEFAULT_LAYERS)).toEqual([]);
    expect(layersToReveal([], DEFAULT_LAYERS)).toEqual([]);
  });
});
