/**
 * When was this resident's primary prompt cache last touched? (Opus 5.5 for
 * Ian, 2026-09-26.) Feeds agent-framework's prompt-cache probe, which
 * context-manager's opt-in `kvStableCacheAware` uses to time memory refolds:
 * a refold on a COLD cache costs nothing extra (the next request rewrites the
 * prefix anyway); on a WARM one it costs a full rewrite.
 *
 * A touch is a real primary-lane (stream) call that read or wrote the cache,
 * or a keepalive refresh. Seeded at startup from the call ledger, which
 * replays earlier process logs: a restart does NOT clear the provider cache,
 * so "just restarted" must never read as cold.
 *
 * State: 'cold' once untouched past TTL + margin; 'warm' while within
 * TTL - margin; otherwise (the edge, or no history) undefined = unknown,
 * which the strategy treats as classic behaviour. One clock per host
 * process (a resident host runs one agent).
 */
export type PromptCacheState = 'cold' | 'warm' | undefined;

export class PromptCacheClock {
  private lastTouchMs: number | undefined;

  constructor(
    private readonly ttlMs: number = 60 * 60_000,
    private readonly marginMs: number = 2 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** A provider call record (the logging adapter's ProviderCallRecord). */
  noteCall(r: { timestamp: string; kind: 'complete' | 'stream'; cacheReadTokens?: number; cacheWriteTokens?: number; error?: string }): void {
    if (r.kind !== 'stream' || r.error) return;
    if ((r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0) <= 0) return;
    const t = Date.parse(r.timestamp);
    if (Number.isFinite(t)) this.touch(t);
  }

  /** A keepalive poke that READ the entry (membrane 'refreshed' event). */
  noteRefresh(atMs: number = this.now()): void {
    this.touch(atMs);
  }

  /** Seed from call-ledger rows (earlier processes included). */
  seed(rows: ReadonlyArray<{ timestamp: string; kind: 'complete' | 'stream'; tokens?: { cacheRead?: number; cacheWrite?: number } }>): void {
    for (const row of rows) {
      this.noteCall({ timestamp: row.timestamp, kind: row.kind, cacheReadTokens: row.tokens?.cacheRead, cacheWriteTokens: row.tokens?.cacheWrite });
    }
  }

  state(): PromptCacheState {
    if (this.lastTouchMs === undefined) return undefined;
    const age = this.now() - this.lastTouchMs;
    if (age > this.ttlMs + this.marginMs) return 'cold';
    if (age < this.ttlMs - this.marginMs) return 'warm';
    return undefined;
  }

  /** Last touch (ms epoch), for operators and tests. */
  lastTouch(): number | undefined {
    return this.lastTouchMs;
  }

  private touch(t: number): void {
    if (this.lastTouchMs === undefined || t > this.lastTouchMs) this.lastTouchMs = t;
  }
}
