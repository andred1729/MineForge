import { describe, expect, it } from 'vitest';

import { lastItemAcrossPages } from '../src/trueforgePort.js';

interface FakePage<T> {
  data: T[];
  hasNextPage(): boolean;
  getNextPage(): Promise<FakePage<T>>;
}

function pages<T>(values: T[][]): FakePage<T> {
  const [current = [], ...remaining] = values;
  return {
    data: current,
    hasNextPage: () => remaining.length > 0,
    getNextPage: async () => pages(remaining),
  };
}

describe('TrueForge turn lookup', () => {
  it('returns the newest turn from the final API page', async () => {
    await expect(lastItemAcrossPages(pages([['old-1', 'old-2'], ['current']]))).resolves.toBe('current');
  });

  it('returns null for an empty session', async () => {
    await expect(lastItemAcrossPages(pages<string>([[]]))).resolves.toBeNull();
  });
});
