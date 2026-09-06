import { describe, expect, it } from 'vitest';
import { groupItems, PaletteItem, rankItems, scoreText } from './palette';

const item = (id: string, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
  id, title, kind: 'command', group: 'Actions', run: () => {}, ...extra,
});

describe('scoreText', () => {
  it('prefers exact, then prefix, then word prefix, then substring, then subsequence', () => {
    expect(scoreText('deploy', 'deploy')).toBeGreaterThan(scoreText('deploy', 'deploy to dev'));
    expect(scoreText('dev', 'deploy to dev')).toBeGreaterThan(scoreText('dev', 'undeveloped'));
    expect(scoreText('ploy', 'deploy')).toBeGreaterThan(scoreText('dpy', 'deploy'));
    expect(scoreText('dpy', 'deploy')).toBeGreaterThan(0);
  });
  it('returns 0 when a character is missing', () => {
    expect(scoreText('xyz', 'deploy')).toBe(0);
  });
  it('treats an empty query as a match', () => {
    expect(scoreText('', 'anything')).toBeGreaterThan(0);
  });
  it('splits words on the separators names use', () => {
    expect(scoreText('orders', 'shop-orders-table')).toBe(80);
    expect(scoreText('table', 'shop_orders_table')).toBe(80);
  });
});

describe('rankItems', () => {
  const items = [
    item('a', 'Fit view'),
    item('b', 'Deploy to Development', { subtitle: 'Runs warpcore deploy' }),
    item('c', 'orders-table', { kind: 'resource', group: 'Resources', subtitle: 'DynamoDB Table · dynamodb-1', keywords: ['dynamodb'] }),
    item('d', 'Destroy Development'),
  ];

  it('keeps the given order for an empty query', () => {
    expect(rankItems('', items).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('ranks the best title match first', () => {
    expect(rankItems('deploy', items)[0].id).toBe('b');
    expect(rankItems('destroy', items)[0].id).toBe('d');
  });
  it('finds resources by keyword and subtitle', () => {
    expect(rankItems('dynamodb', items).map((i) => i.id)).toEqual(['c']);
    expect(rankItems('dynamodb-1', items).map((i) => i.id)).toEqual(['c']);
  });
  it('drops non-matches and honours the limit', () => {
    expect(rankItems('zzz', items)).toEqual([]);
    expect(rankItems('', items, 2).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('groupItems', () => {
  it('groups in first-seen order', () => {
    const grouped = groupItems([
      item('1', 'x', { group: 'View' }),
      item('2', 'y', { group: 'Actions' }),
      item('3', 'z', { group: 'View' }),
    ]);
    expect(grouped.map((g) => [g.group, g.items.length])).toEqual([['View', 2], ['Actions', 1]]);
  });
});
