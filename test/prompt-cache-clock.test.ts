import { describe, expect, test } from 'bun:test';
import { PromptCacheClock } from '../src/prompt-cache-clock.js';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const min = 60_000;
const call = (atMs: number, extra: Record<string, unknown> = {}) =>
  ({ timestamp: new Date(atMs).toISOString(), kind: 'stream' as const, cacheReadTokens: 700_000, cacheWriteTokens: 0, ...extra });

describe('PromptCacheClock', () => {
  test('unknown without history; warm inside the TTL; unknown at the edge; cold past it', () => {
    let now = T0;
    const c = new PromptCacheClock(60 * min, 2 * min, () => now);
    expect(c.state()).toBeUndefined();
    c.noteCall(call(T0));
    now = T0 + 30 * min; expect(c.state()).toBe('warm');
    now = T0 + 60 * min; expect(c.state()).toBeUndefined();
    now = T0 + 63 * min; expect(c.state()).toBe('cold');
  });

  test('keepalive refreshes and later calls keep it warm; older records never move it back', () => {
    let now = T0;
    const c = new PromptCacheClock(60 * min, 2 * min, () => now);
    c.noteCall(call(T0));
    now = T0 + 50 * min; c.noteRefresh();
    now = T0 + 100 * min; expect(c.state()).toBe('warm');
    c.noteCall(call(T0 - 5 * min));
    expect(c.lastTouch()).toBe(T0 + 50 * min);
  });

  test('only primary-lane calls that touched the cache count', () => {
    let now = T0 + 10 * min;
    const c = new PromptCacheClock(60 * min, 2 * min, () => now);
    c.noteCall(call(T0, { kind: 'complete' }));
    c.noteCall(call(T0, { error: '500' }));
    c.noteCall(call(T0, { cacheReadTokens: 0, cacheWriteTokens: 0 }));
    expect(c.state()).toBeUndefined();
  });

  test('seeded from ledger rows (earlier processes): a restart is not "cold"', () => {
    const now = T0 + 20 * min;
    const c = new PromptCacheClock(60 * min, 2 * min, () => now);
    c.seed([{ timestamp: new Date(T0).toISOString(), kind: 'stream', tokens: { cacheRead: 700_000, cacheWrite: 0 } }]);
    expect(c.state()).toBe('warm');
  });
});

describe('recipe', () => {
  test('accepts kvStableCacheAware and cacheKeepalive.resumeAfterHours, and passes the strategy flag through', () => {
    const recipe = validateRecipe({
      name: 'x',
      agent: {
        name: 'A', model: 'claude-fable-5', systemPrompt: 'hi',
        strategy: { type: 'autobiographical', kvStableCacheAware: true },
        cacheKeepalive: { enabled: true, resumeAfterHours: 6 },
      },
    }) as { agent: { strategy?: Record<string, unknown>; cacheKeepalive?: Record<string, unknown> } };
    expect(recipe.agent.cacheKeepalive?.resumeAfterHours).toBe(6);
    const strat = buildFrameworkStrategy(recipe as never) as unknown as { config?: Record<string, unknown> };
    expect(JSON.stringify(strat.config ?? strat)).toContain('kvStableCacheAware');
  });
});
