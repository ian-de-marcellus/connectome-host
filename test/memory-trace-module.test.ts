import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryTraceModule,
  cleanScratch,
  scorePassage,
  traceQuote,
  type TraceMessage,
  type TraceSource,
  type TraceSummary,
} from '../src/modules/memory-trace-module.js';

// A tiny memory tree:
//   L2-10 ← L1-1 (m1,m2), L1-2 (m3,m4)
//   L2-11 ← L1-3 (m5,m6)            (a separate lineage)
const msg = (id: string, participant: string, minute: number, text: string): TraceMessage => ({
  id, participant, timestamp: new Date(Date.UTC(2026, 8, 12, 7, minute)), content: [{ type: 'text', text }],
});
const messages: TraceMessage[] = [
  msg('m1', 'Ian', 0, 'Good morning. How was the night?'),
  msg('m2', 'Fable', 1, 'The lamp looks like it is guttering when it is, which is the whole point of the notice.'),
  msg('m3', 'Ian', 2, 'Can you check the spectrogram?'),
  msg('m4', 'Fable', 3, 'The spectrogram is a wall of sound at 4:47.'),
  msg('m5', 'Ian', 4, 'Different day, different topic entirely.'),
  msg('m6', 'Fable', 5, 'Doctrine repeats: the lamp looks like it is guttering when it is.'),
];
const L1 = (id: string, content: string, sourceIds: string[], parent?: string): TraceSummary =>
  ({ id, level: 1, sourceLevel: 0, content, sourceIds, ...(parent ? { mergedInto: parent } : {}) });
const summaries: TraceSummary[] = [
  L1('L1-1', 'I told Ian the lamp looks like it\'s guttering when it is — that was the point of the failure notice.', ['m1', 'm2'], 'L2-10'),
  L1('L1-2', 'Ian asked about the spectrogram; I described a wall of sound at 4:47.', ['m3', 'm4'], 'L2-10'),
  L1('L1-3', 'A separate day where I repeated that the lamp looks like it\'s guttering when it is.', ['m5', 'm6'], 'L2-11'),
  { id: 'L2-10', level: 2, sourceLevel: 1, content: 'Morning with Ian: the lamp looks like it\'s guttering when it is; then the spectrogram, a wall of sound.', sourceIds: ['L1-1', 'L1-2'] },
  { id: 'L2-11', level: 2, sourceLevel: 1, content: 'Another day, restating doctrine about notices.', sourceIds: ['L1-3'] },
];
const source: TraceSource = { summaries: () => summaries, messages: () => messages };
const opts = { timeZone: 'Europe/Paris', maxResults: 3 };

describe('matching', () => {
  test('verbatim (normalized) scores 1; small differences stay above threshold', () => {
    expect(scorePassage('the spectrogram, a wall of sound', summaries[3]!.content)).toBe(1);
    expect(scorePassage('THE   spectrogram — a wall of sound!', summaries[3]!.content)).toBe(1);
    expect(scorePassage('then the spectrogram a wall of noise', summaries[3]!.content)).toBeGreaterThan(0.5);
  });

  test('exact quote in one memory traces it one level down, with labels', () => {
    const out = traceQuote(source, { quote: 'a wall of sound at 4:47' }, opts);
    expect(out.kind).toBe('match');
    expect(out.matchedIds).toEqual(['L1-2']);
    expect(out.text).toContain('TRACED MATERIAL');
    expect(out.text).toContain('[L1 L1-2 ·');
    expect(out.text).toContain('raw messages of L1-2');
    // raw line: time · sender · message id · text, in the agent's zone
    expect(out.text).toMatch(/2026-09-12T09:03:00(\.000)?\+02:00 \[Europe\/Paris\] · Fable · m4 · The spectrogram is a wall of sound at 4:47\./);
  });

  test('a quote in two separate lineages returns both (never auto-picks)', () => {
    const out = traceQuote(source, { quote: "the lamp looks like it's guttering when it is" }, opts);
    expect(out.kind).toBe('multiple');
    // L2-10 carries L1-1's wording (same lineage, collapsed); L1-3 is separate.
    expect(out.matchedIds.sort()).toEqual(['L1-3', 'L2-10'].sort());
    expect(out.text).toContain('appears in 2 separate memories');
    expect(out.text).toContain('also carried in L1-1');
    expect(out.text).toContain('memoryId');
  });

  test('memoryId narrows a multiple match to one', () => {
    const out = traceQuote(source, { quote: "the lamp looks like it's guttering when it is", memoryId: 'L1-3' }, opts);
    expect(out.kind).toBe('match');
    expect(out.matchedIds).toEqual(['L1-3']);
  });

  test('a miss says so plainly and offers nearest passages', () => {
    const out = traceQuote(source, { quote: 'the candle burned down to nothing overnight' }, opts);
    expect(out.kind).toBe('miss');
    expect(out.text).toContain('NO MATCH');
    expect(out.text).toContain('misquoting your own past');
    expect(out.text).toContain('Closest passages:');
    expect(out.text).toMatch(/\[L\d L\d-\d+ · .* · match \d+%/);
  });
});

describe('descent', () => {
  test('L2 → its L1s, ranked, each labeled with level and span', () => {
    const out = traceQuote(source, { quote: 'then the spectrogram, a wall of sound', memoryId: 'L2-10' }, opts);
    expect(out.text).toContain('L2-10 was made from 2 L1 memories');
    const i1 = out.text.indexOf('[L1 L1-2');
    const i2 = out.text.indexOf('[L1 L1-1');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1); // best-matching child first
    expect(out.text).toMatch(/strong match|partial/);
  });

  test('depth raw walks L2 → L1 → raw messages', () => {
    const out = traceQuote(source, { quote: 'then the spectrogram, a wall of sound', memoryId: 'L2-10', depth: 'raw' }, opts);
    expect(out.text).toContain('raw messages of L1-2');
    expect(out.text).toContain('◆ ');
    expect(out.text).toContain('· m4 ·');
  });
});

describe('delivery and scratch', () => {
  const makeModule = (dir: string, inlineMaxTokens: number) => {
    const mod = new MemoryTraceModule({ scratchDir: dir, inlineMaxTokens, ttlDays: 7, timeZone: 'Europe/Paris' });
    mod.setSource(() => source);
    return mod;
  };
  const call = (input: Record<string, unknown>) => ({ id: 'c1', name: 'trace', input }) as never;

  test('small results are returned inline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const res = await makeModule(dir, 8000).handleToolCall(call({ quote: 'a wall of sound at 4:47' }));
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain('TRACED MATERIAL');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('results over the ceiling go to a scratch file with a digest and path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const res = await makeModule(dir, 10).handleToolCall(call({ quote: 'a wall of sound at 4:47' }));
    expect(res.success).toBe(true);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-a-wall-of-sound-at-4-47\.md$/);
    expect(String(res.data)).toContain(join(dir, files[0]!));
    expect(String(res.data)).toContain('deleted after 7 days');
    expect(readFileSync(join(dir, files[0]!), 'utf8')).toContain('· m4 ·');
  });

  test('scratch paths can be shown the way the workspace names them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const dir = join(root, 'runtime', 'memory-traces');
    const mod = new MemoryTraceModule({ scratchDir: dir, inlineMaxTokens: 10, timeZone: 'Europe/Paris', displayRoot: { path: root, as: 'self-map' } });
    mod.setSource(() => source);
    const res = await mod.handleToolCall(call({ quote: 'a wall of sound at 4:47' }));
    expect(String(res.data)).toMatch(/self-map\/runtime\/memory-traces\/\d{4}-.*\.md/);
  });

  test('TTL cleanup removes only our own old scratch files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const old = join(dir, '2026-09-01T10-00-00Z-old-trace.md');
    const fresh = join(dir, '2026-09-23T10-00-00Z-fresh-trace.md');
    const foreign = join(dir, 'notes-i-kept.md');
    for (const p of [old, fresh, foreign]) writeFileSync(p, 'x');
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    utimesSync(foreign, tenDaysAgo, tenDaysAgo);
    expect(cleanScratch(dir, 7, new Date())).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  test('empty quote is rejected; the tool is read-only (no store writes exposed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const res = await makeModule(dir, 8000).handleToolCall(call({ quote: '  ' }));
    expect(res.success).toBe(false);
  });
});
