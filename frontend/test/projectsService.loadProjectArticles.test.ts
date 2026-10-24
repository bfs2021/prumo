import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Article} from '@/types/article';

// A Supabase builder that serves a server capped at 1,000 rows: without an
// explicit .range() a read returns at most the cap; with one, exactly the
// requested window.
function makeCappedQuery(all: Record<string, unknown>[], cap = 1000) {
  const calls: Array<[number, number]> = [];
  let ranged = false;
  let from = 0;
  let to = 0;
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    range(fromArg: number, toArg: number) {
      ranged = true;
      from = fromArg;
      to = toArg;
      calls.push([fromArg, toArg]);
      return builder;
    },
    then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
      const end = ranged ? to : Math.min(all.length, cap) - 1;
      const page = end < from ? [] : all.slice(from, end + 1);
      Promise.resolve({data: page, error: null}).then(resolve, reject);
    },
  };
  return {builder, calls};
}

let query: ReturnType<typeof makeCappedQuery>;

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => query.builder,
  },
}));

import {loadProjectArticles} from '@/services/projectsService';

function rows(count: number): Record<string, unknown>[] {
  return Array.from({length: count}, (_, i) => ({id: `a${count - i}`})) as Record<string, unknown>[];
}

describe('loadProjectArticles', () => {
  beforeEach(() => {
    query = makeCappedQuery(rows(2500));
  });

  it('pages past the server max-rows cap and returns every article', async () => {
    const result = await loadProjectArticles('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Article[]).length).toBe(2500);
    expect(query.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('stops paging on a short page', async () => {
    query = makeCappedQuery(rows(120));

    const result = await loadProjectArticles('p1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Article[]).length).toBe(120);
    expect(query.calls).toEqual([[0, 999]]);
  });
});
