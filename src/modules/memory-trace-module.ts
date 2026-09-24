/**
 * memory--trace: take a passage from one of the agent's memories (as it reads
 * in context) and show what that memory was made from, one level down (L3 → its
 * L2s, L2 → its L1s, L1 → the raw messages) or all the way to raw.
 *
 * Designed with Fable (notes/designs/memory-trace-tool.md, "agreed spec"):
 * - the quote is the handle (recall headers carry no ids);
 * - every returned piece is labeled with its level and span, and the whole
 *   result is marked as TRACED material — fetched must never masquerade as
 *   remembered;
 * - several matching memories are all shown (multiplicity is a finding);
 * - a miss is the highest-value result: said plainly, with nearest passages;
 * - small results inline, large ones to a scratch file (temporary; copied
 *   out by the agent if worth keeping);
 * - strictly read-only: nothing here writes to memory or the message store.
 *
 * v2 seam (not built): reverse trace — "which of my memories covers this raw
 * message / file?" — would reuse `scorePassage` and `leafIdsOf` below against
 * the summary set, walking upward via parent pointers.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatZonedDateTime, resolveTimeZone } from '@animalabs/agent-framework';
import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';

// ---------------------------------------------------------------------------
// Minimal views of the context-manager objects this module reads
// ---------------------------------------------------------------------------

export interface TraceSummary {
  id: string;
  level: number;
  content: string;
  sourceLevel: number;
  sourceIds: string[];
  mergedInto?: string;
  parentId?: string;
}

export interface TraceMessage {
  id: string;
  participant?: string;
  timestamp?: unknown;
  content?: unknown[];
}

/** What the module needs from an agent's context manager. */
export interface TraceSource {
  summaries(): TraceSummary[];
  messages(): TraceMessage[];
}

export interface MemoryTraceConfig {
  /** Directory for large traces. Files here are temporary scratch. */
  scratchDir: string;
  /** Scratch files older than this are deleted (on start and each call). */
  ttlDays?: number;
  /** Results estimated above this many tokens go to a file (hard ceiling). */
  inlineMaxTokens?: number;
  /** Children / nearest passages shown per level (default 3). */
  maxResults?: number;
  /** Show scratch paths the way the agent's workspace tools name them, e.g.
   *  { path: '/Users/x/Projects/self-map', as: 'self-map' }. */
  displayRoot?: { path: string; as: string };
  timeZone?: string;
  /** Test hook. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

/** Lowercase, strip markdown/punctuation, unify quotes and dashes, collapse space. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  const n = normalizeText(text);
  return n ? n.split(' ') : [];
}

/** How much of `quote` the passage accounts for, 0..1. 1 = contains it
 *  verbatim (after normalization); otherwise a blend of word and word-pair
 *  coverage, so small differences still score high and paraphrase scores
 *  lower. */
export function scorePassage(quote: string, passage: string): number {
  const q = normalizeText(quote);
  if (!q) return 0;
  const p = normalizeText(passage);
  if (p.includes(q)) return 1;
  const qt = q.split(' ');
  const pt = new Set(p.split(' '));
  const unigram = qt.filter((t) => pt.has(t)).length / qt.length;
  if (qt.length < 2) return unigram * 0.9;
  const pairs = new Set<string>();
  const pw = p.split(' ');
  for (let i = 0; i + 1 < pw.length; i++) pairs.add(`${pw[i]} ${pw[i + 1]}`);
  let hit = 0;
  for (let i = 0; i + 1 < qt.length; i++) if (pairs.has(`${qt[i]} ${qt[i + 1]}`)) hit++;
  const bigram = hit / (qt.length - 1);
  // Never let a non-verbatim passage tie a verbatim one.
  return Math.min(0.99, 0.4 * unigram + 0.6 * bigram);
}

/** A quote "is in" a memory at or above this score (small differences allowed). */
export const MATCH_THRESHOLD = 0.8;

/** The sentence / line of `text` that best accounts for `quote`, trimmed. */
export function bestSnippet(quote: string, text: string, maxChars = 260): string {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let best = parts[0] ?? '';
  let bestScore = -1;
  for (const s of parts) {
    const sc = scorePassage(quote, s);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  const flat = best.replace(/\s+/g, ' ');
  return flat.length > maxChars ? flat.slice(0, maxChars - 1) + '…' : flat;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

const parentOf = (s: TraceSummary): string | undefined => s.mergedInto ?? s.parentId;

export function leafIdsOf(s: TraceSummary, byId: Map<string, TraceSummary>, seen = new Set<string>()): string[] {
  if (seen.has(s.id)) return [];
  seen.add(s.id);
  if (s.sourceLevel === 0) return [...s.sourceIds];
  const out: string[] = [];
  for (const c of s.sourceIds) {
    const child = byId.get(c);
    if (child) out.push(...leafIdsOf(child, byId, seen));
  }
  return out;
}

function isAncestor(a: TraceSummary, b: TraceSummary, byId: Map<string, TraceSummary>): boolean {
  let cur: TraceSummary | undefined = b;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = parentOf(cur);
    if (!p) return false;
    if (p === a.id) return true;
    cur = byId.get(p);
  }
  return false;
}

function messageText(m: TraceMessage): string {
  const parts: string[] = [];
  for (const b of (m.content ?? []) as Array<Record<string, unknown>>) {
    if (b?.type === 'text') parts.push(String(b.text ?? ''));
    else if (b?.type === 'tool_use') parts.push(`[tool call ${String(b.name ?? '')}] ${JSON.stringify(b.input ?? {})}`);
    else if (b?.type === 'tool_result') {
      const c = b.content;
      parts.push(`[tool result] ${typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join(' ') : ''}`);
    } else if (b?.type === 'image') parts.push('[image]');
    // thinking blocks are deliberately omitted: private reasoning is not part of the record shown here
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HEADER =
  '── TRACED MATERIAL · fetched from your memory records, not remembered ──\n' +
  'Everything below was looked up just now. Treat it as the exhibit, not the testimony.';

interface Ctx {
  byId: Map<string, TraceSummary>;
  msgById: Map<string, TraceMessage>;
  order: Map<string, number>;
  fmt: (t: unknown) => string;
  maxResults: number;
}

function spanOf(s: TraceSummary, c: Ctx): { first: TraceMessage | undefined; last: TraceMessage | undefined; count: number } {
  const leaves = leafIdsOf(s, c.byId).filter((id) => c.msgById.has(id))
    .sort((a, b) => (c.order.get(a) ?? 0) - (c.order.get(b) ?? 0));
  return { first: c.msgById.get(leaves[0]!), last: c.msgById.get(leaves[leaves.length - 1]!), count: leaves.length };
}

function label(s: TraceSummary, c: Ctx): string {
  const sp = spanOf(s, c);
  const when = sp.first ? `${c.fmt(sp.first.timestamp)} → ${c.fmt(sp.last?.timestamp)}` : 'span unknown';
  const ids = sp.first ? `messages ${sp.first.id}…${sp.last?.id} (${sp.count})` : '';
  return `[L${s.level} ${s.id} · ${when}${ids ? ` · ${ids}` : ''}]`;
}

function rawLine(m: TraceMessage, c: Ctx, mark = ''): string {
  return `${mark}${c.fmt(m.timestamp)} · ${m.participant ?? '?'} · ${m.id} · ${messageText(m)}`;
}

function confidence(scores: number[]): string {
  const best = scores[0] ?? 0;
  if (best >= 0.6) return 'strong match';
  const top = scores.slice(0, 3).reduce((a, b) => a + b, 0);
  if (top >= 0.6) return 'partial: these pieces together';
  return 'weak: the passage is paraphrased at this level; closest pieces shown';
}

/** One level down from `s`, ranked against the quote. */
function descend(quote: string, s: TraceSummary, c: Ctx, depth: 'one' | 'raw', indent = ''): string[] {
  const out: string[] = [];
  if (s.sourceLevel === 0) {
    const msgs = s.sourceIds.map((id) => c.msgById.get(id)).filter((m): m is TraceMessage => !!m)
      .sort((a, b) => (c.order.get(a.id) ?? 0) - (c.order.get(b.id) ?? 0));
    const scored = msgs.map((m) => ({ m, sc: scorePassage(quote, messageText(m)) }));
    const topIds = new Set([...scored].sort((a, b) => b.sc - a.sc).slice(0, c.maxResults).filter((x) => x.sc > 0.15).map((x) => x.m.id));
    const ranked = [...scored].sort((a, b) => b.sc - a.sc).map((x) => x.sc);
    out.push(`${indent}raw messages of ${s.id} (${msgs.length}) — ${confidence(ranked)}; ◆ marks the lines that best account for the passage:`);
    for (const { m } of scored) out.push(indent + rawLine(m, c, topIds.has(m.id) ? '◆ ' : '  '));
    if (msgs.length < s.sourceIds.length) out.push(`${indent}(${s.sourceIds.length - msgs.length} source message(s) no longer in the store)`);
    return out;
  }
  const children = s.sourceIds.map((id) => c.byId.get(id)).filter((x): x is TraceSummary => !!x)
    .map((ch) => ({ ch, sc: scorePassage(quote, ch.content) }))
    .sort((a, b) => b.sc - a.sc);
  out.push(`${indent}${s.id} was made from ${children.length} L${s.level - 1} memories — ${confidence(children.map((x) => x.sc))}:`);
  const shown = children.slice(0, c.maxResults);
  for (const { ch } of shown) {
    out.push('', `${indent}${label(ch, c)}`);
    if (depth === 'raw') out.push(...descend(quote, ch, c, 'raw', indent + '  '));
    else out.push(...ch.content.split('\n').map((l) => indent + l));
  }
  const rest = children.slice(c.maxResults);
  if (rest.length) out.push('', `${indent}(also made from: ${rest.map((x) => x.ch.id).join(', ')} — lower match)`);
  return out;
}

// ---------------------------------------------------------------------------
// The trace itself (pure; exported for tests)
// ---------------------------------------------------------------------------

export interface TraceOutcome {
  kind: 'match' | 'multiple' | 'miss';
  text: string;
  /** Raw-line body for a scratch file (same as text; kept separate for clarity). */
  matchedIds: string[];
}

export function traceQuote(
  source: TraceSource,
  input: { quote: string; depth?: 'one' | 'raw'; memoryId?: string },
  opts: { timeZone: string; maxResults: number },
): TraceOutcome {
  const quote = input.quote.trim();
  const summaries = source.summaries();
  const messages = source.messages();
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const msgById = new Map(messages.map((m) => [m.id, m]));
  const order = new Map(messages.map((m, i) => [m.id, i]));
  const fmt = (t: unknown): string => {
    const d = t instanceof Date ? t : new Date(t as string | number);
    return Number.isFinite(d.getTime()) ? formatZonedDateTime(d, opts.timeZone) : '?';
  };
  const c: Ctx = { byId, msgById, order, fmt, maxResults: opts.maxResults };
  const depth = input.depth === 'raw' ? 'raw' : 'one';

  const scored = summaries.map((s) => ({ s, sc: scorePassage(quote, s.content) })).sort((a, b) => b.sc - a.sc);
  let matches = scored.filter((x) => x.sc >= MATCH_THRESHOLD);
  if (input.memoryId) matches = matches.filter((x) => x.s.id === input.memoryId);

  if (matches.length === 0) {
    const lines = [HEADER, '',
      input.memoryId
        ? `NO MATCH in ${input.memoryId}. That memory does not contain this passage.`
        : 'NO MATCH. None of your memories contains this passage. You may be misquoting your own past — ' +
          'check the wording against the closest passages below before relying on it.',
      '', 'Closest passages:'];
    for (const { s, sc } of scored.slice(0, opts.maxResults)) {
      lines.push(`  ${label(s, c)} · match ${(sc * 100).toFixed(0)}%`, `    "${bestSnippet(quote, s.content)}"`);
    }
    return { kind: 'miss', text: lines.join('\n'), matchedIds: [] };
  }

  // Collapse lineage: a quote carried verbatim from a child into its parent is
  // one chain, not two memories. Keep the highest-level member of each chain.
  const chains: Array<{ top: TraceSummary; members: TraceSummary[] }> = [];
  for (const { s } of [...matches].sort((a, b) => b.s.level - a.s.level)) {
    const chain = chains.find((ch) => isAncestor(ch.top, s, byId) || ch.members.some((m) => isAncestor(m, s, byId)));
    if (chain) chain.members.push(s);
    else chains.push({ top: s, members: [s] });
  }

  const lines = [HEADER, ''];
  if (chains.length > 1) {
    lines.push(`This passage appears in ${chains.length} separate memories — that multiplicity is itself worth a look ` +
      '(repeated on purpose, or one event\'s language carried into another\'s record?):');
    for (const ch of chains) {
      lines.push(`  ${label(ch.top, c)}${ch.members.length > 1 ? ` (also carried in ${ch.members.slice(1).map((m) => m.id).join(', ')})` : ''}`,
        `    "${bestSnippet(quote, ch.top.content)}"`);
    }
    lines.push('', 'Tracing each one level down:');
    for (const ch of chains) lines.push('', `━━ ${label(ch.top, c)}`, ...descend(quote, ch.top, c, depth));
    lines.push('', 'To trace just one of these, call again with memoryId set to its id.');
    return { kind: 'multiple', text: lines.join('\n'), matchedIds: chains.map((ch) => ch.top.id) };
  }

  const only = chains[0]!;
  lines.push(`Found in ${label(only.top, c)}${only.members.length > 1 ? ` (the same wording is carried in ${only.members.slice(1).map((m) => m.id).join(', ')})` : ''}`,
    `  "${bestSnippet(quote, only.top.content)}"`, '');
  lines.push(...descend(quote, only.top, c, depth));
  return { kind: 'match', text: lines.join('\n'), matchedIds: [only.top.id] };
}

// ---------------------------------------------------------------------------
// Scratch files
// ---------------------------------------------------------------------------

const SCRATCH_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z?-[a-z0-9-]*\.md$/;

export function slugify(text: string): string {
  return normalizeText(text).split(' ').slice(0, 8).join('-').replace(/[^a-z0-9-]/g, '').slice(0, 60) || 'trace';
}

/** Delete our own scratch files older than ttlDays. Only files matching the
 *  module's naming pattern are ever touched. Returns the number removed. */
export function cleanScratch(dir: string, ttlDays: number, now: Date): number {
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - ttlDays * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!SCRATCH_NAME.test(name)) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
    } catch { /* raced or unreadable: leave it */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class MemoryTraceModule implements Module {
  readonly name = 'memory';
  private source: ((agentName?: string) => TraceSource | null) | null = null;
  private readonly scratchDir: string;
  private readonly ttlDays: number;
  private readonly inlineMaxTokens: number;
  private readonly maxResults: number;
  private readonly timeZone: string;
  private readonly now: () => Date;
  private readonly displayRoot?: { path: string; as: string };

  constructor(config: MemoryTraceConfig) {
    this.scratchDir = resolve(config.scratchDir);
    this.ttlDays = config.ttlDays ?? 7;
    this.inlineMaxTokens = config.inlineMaxTokens ?? 8000;
    this.maxResults = config.maxResults ?? 3;
    this.timeZone = resolveTimeZone(config.timeZone);
    this.now = config.now ?? (() => new Date());
    this.displayRoot = config.displayRoot ? { path: resolve(config.displayRoot.path), as: config.displayRoot.as } : undefined;
  }

  private shownPath(abs: string): string {
    const root = this.displayRoot;
    if (root && (abs === root.path || abs.startsWith(root.path + '/'))) {
      return `${root.as}/${abs.slice(root.path.length + 1)}`;
    }
    return abs;
  }

  /** Bound after framework creation: resolve an agent's memory records. */
  setSource(source: (agentName?: string) => TraceSource | null): void {
    this.source = source;
  }

  async start(_ctx: ModuleContext): Promise<void> {
    cleanScratch(this.scratchDir, this.ttlDays, this.now());
  }

  async stop(): Promise<void> {}

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [{
      name: 'trace',
      description:
        'Trace a passage from one of your memories back to what it was made from. Quote the passage as it reads ' +
        'in your context (small wording differences are fine); you get the memory it lives in and the pieces one level ' +
        `down (L3→L2s, L2→L1s, L1→the raw messages), each labeled with its level and span. depth "raw" goes all the way ` +
        `down. If several memories contain the passage you see all of them; if none does, you are told so plainly, with the ` +
        `closest passages. Read-only. Large traces are written to a temporary scratch file (deleted after ${this.ttlDays} days) — ` +
        'copy anything worth keeping somewhere of your own.',
      inputSchema: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'The passage, as it reads in your memory.' },
          depth: { type: 'string', enum: ['one', 'raw'], description: 'One level down (default) or all the way to the raw messages.' },
          memoryId: { type: 'string', description: 'Optional: trace only this memory (from an earlier trace result), when a passage matched several.' },
          maxResults: { type: 'number', description: `Pieces shown per level (default ${this.maxResults}).` },
        },
        required: ['quote'],
      },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== 'trace') return { success: false, error: `Unknown tool ${call.name}`, isError: true };
    const input = (call.input ?? {}) as { quote?: unknown; depth?: unknown; memoryId?: unknown; maxResults?: unknown };
    if (typeof input.quote !== 'string' || !input.quote.trim()) {
      return { success: false, error: 'quote is required (the passage as it reads in your memory).', isError: true };
    }
    const source = this.source?.(call.callerAgentName) ?? null;
    if (!source) return { success: false, error: 'Memory records are not available yet.', isError: true };

    const now = this.now();
    cleanScratch(this.scratchDir, this.ttlDays, now);
    const maxResults = typeof input.maxResults === 'number' && input.maxResults >= 1
      ? Math.min(10, Math.floor(input.maxResults)) : this.maxResults;
    const outcome = traceQuote(source, {
      quote: input.quote,
      depth: input.depth === 'raw' ? 'raw' : 'one',
      memoryId: typeof input.memoryId === 'string' ? input.memoryId : undefined,
    }, { timeZone: this.timeZone, maxResults });

    const estTokens = Math.ceil(outcome.text.length / 4);
    if (estTokens <= this.inlineMaxTokens) return { success: true, data: outcome.text };

    mkdirSync(this.scratchDir, { recursive: true });
    const stamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const path = join(this.scratchDir, `${stamp}-${slugify(input.quote)}.md`);
    writeFileSync(path, `# memory trace — ${now.toISOString()}\n\nQuote: "${input.quote.trim()}"\n\n${outcome.text}\n`);
    const digest = outcome.text.split('\n').slice(0, 14).join('\n');
    return {
      success: true,
      data:
        `${digest}\n…\n\n` +
        `The full trace (~${estTokens} tokens) is in a temporary scratch file:\n  ${this.shownPath(path)}\n` +
        `It will be deleted after ${this.ttlDays} days — copy anything worth keeping somewhere of your own.`,
    };
  }
}
