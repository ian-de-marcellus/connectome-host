/**
 * Exact, model-facing context substitutions.
 *
 * This deliberately sits at the provider boundary: Chronicle and Context
 * Manager retain the original messages, while the provider receives a
 * reversible representation selected by a SHA-256 match.  A rule cannot
 * rewrite a merely similar message, and an invalid configuration prevents
 * host startup instead of silently weakening the match.
 */

import type { ProviderRequest } from '@animalabs/membrane';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const SCHEMA = 'connectome-model-context-substitutions/v1';
const SHA256_RE = /^[a-f0-9]{64}$/;

interface ReplacementSource {
  file: string;
  section: string;
  /** Drop this many leading Markdown paragraphs from the selected section. */
  dropLeadingParagraphs?: number;
  prefix?: string;
}

interface SubstitutionRuleFile {
  id: string;
  sha256: string;
  /** Limit the exact replacement to selected provider call kinds. */
  kinds?: SubstitutionKind[];
  replacement: string | ReplacementSource;
  /** Remove opaque/signed reasoning siblings from the rewritten message. */
  dropSiblingThinking?: boolean;
}

interface SubstitutionFile {
  schema: string;
  rules?: SubstitutionRuleFile[];
  /** Exact, case-sensitive phrase rewrites within model-facing text. */
  literalReplacements?: LiteralSubstitutionRuleFile[];
  ranges?: RangeSubstitutionRuleFile[];
}

interface SubstitutionRule {
  id: string;
  sha256: string;
  kinds: Set<SubstitutionKind>;
  replacement: string;
  dropSiblingThinking: boolean;
}

interface LiteralSubstitutionRuleFile {
  id: string;
  find: string;
  replacement: string;
  /** Limit the replacement to selected provider call kinds (default: both). */
  kinds?: SubstitutionKind[];
}

interface LiteralSubstitutionRule {
  id: string;
  find: string;
  replacement: string;
  kinds: Set<SubstitutionKind>;
}

type SubstitutionKind = 'complete' | 'stream';

interface RangeAnchorFile {
  role: 'user' | 'assistant';
  textSha256: string;
}

interface RangeReplacementSource {
  file: string;
}

interface RangeSubstitutionRuleFile {
  id: string;
  kinds?: SubstitutionKind[];
  start: RangeAnchorFile;
  /**
   * Ordered later anchors for rolling contexts. The first anchor still
   * present is used when older context selection has naturally evicted the
   * primary start. This keeps the range fail-closed without requiring an old
   * boundary to remain resident forever.
   */
  startFallbacks?: RangeAnchorFile[];
  end: RangeAnchorFile;
  replacement: RangeReplacementSource;
}

interface RangeSubstitutionRule {
  id: string;
  kinds: Set<SubstitutionKind>;
  startAnchors: RangeAnchorFile[];
  end: RangeAnchorFile;
  replacementMessages: ProviderRequest['messages'];
}

export interface SubstitutionResult {
  request: ProviderRequest;
  matchedRuleIds: string[];
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sectionFromMarkdown(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Replacement section not found: ${JSON.stringify(heading)}`);
  const lineEnd = markdown.indexOf('\n', markerIndex + marker.length);
  const bodyStart = lineEnd < 0 ? markdown.length : lineEnd + 1;
  const remainder = markdown.slice(bodyStart);
  const nextHeading = remainder.search(/\n(?:---\s*\n\s*)?## /);
  return (nextHeading < 0 ? remainder : remainder.slice(0, nextHeading)).trim();
}

function dropLeadingParagraphs(text: string, count: number): string {
  if (count === 0) return text;
  const paragraphs = text.split(/\n\s*\n/);
  if (count >= paragraphs.length) {
    throw new Error(`Cannot drop ${count} paragraph(s) from a ${paragraphs.length}-paragraph replacement`);
  }
  return paragraphs.slice(count).join('\n\n').trim();
}

function resolveReplacement(
  replacement: string | ReplacementSource,
  configPath: string,
): string {
  if (typeof replacement === 'string') return replacement;
  if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
    throw new Error('Substitution replacement must be a string or a section source');
  }
  if (typeof replacement.file !== 'string' || !replacement.file) {
    throw new Error('Substitution replacement.file must be a non-empty string');
  }
  if (typeof replacement.section !== 'string' || !replacement.section) {
    throw new Error('Substitution replacement.section must be a non-empty string');
  }
  const drops = replacement.dropLeadingParagraphs ?? 0;
  if (!Number.isSafeInteger(drops) || drops < 0) {
    throw new Error('Substitution replacement.dropLeadingParagraphs must be a non-negative integer');
  }
  const sourcePath = isAbsolute(replacement.file)
    ? replacement.file
    : resolve(dirname(configPath), replacement.file);
  const section = sectionFromMarkdown(readFileSync(sourcePath, 'utf8'), replacement.section);
  const body = dropLeadingParagraphs(section, drops);
  return `${replacement.prefix ?? ''}${body}`;
}

function resolveSourcePath(file: string, configPath: string): string {
  return isAbsolute(file) ? file : resolve(dirname(configPath), file);
}

function conversationFromMarkdown(markdown: string): ProviderRequest['messages'] {
  const marker = /^## (user|assistant)\s*$/gm;
  const matches = [...markdown.matchAll(marker)];
  if (matches.length === 0) {
    throw new Error('Range replacement transcript must contain at least one ## user or ## assistant section');
  }
  const messages = matches.map((match, index) => {
    const role = match[1] as 'user' | 'assistant';
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.length;
    const text = markdown.slice(bodyStart, bodyEnd).trim();
    if (!text) throw new Error(`Range replacement transcript has an empty ${role} section at index ${index}`);
    return { role, content: [{ type: 'text' as const, text }] };
  });
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]!.role === messages[index - 1]!.role) {
      throw new Error(`Range replacement transcript repeats role ${messages[index]!.role} at index ${index}`);
    }
  }
  return messages;
}

function loadRangeRules(
  candidates: RangeSubstitutionRuleFile[] | undefined,
  configPath: string,
  seenIds: Set<string>,
): RangeSubstitutionRule[] {
  if (candidates === undefined) return [];
  if (!Array.isArray(candidates)) throw new Error('Model-context substitution ranges must be an array');
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Model-context range substitution rule ${index} must be an object`);
    }
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || seenIds.has(candidate.id)) {
      throw new Error(`Model-context range substitution rule ${index} has a missing or duplicate id`);
    }
    for (const [label, anchor] of [['start', candidate.start], ['end', candidate.end]] as const) {
      if (!anchor || !['user', 'assistant'].includes(anchor.role) || !SHA256_RE.test(anchor.textSha256)) {
        throw new Error(`Model-context range substitution rule ${candidate.id} has an invalid ${label} anchor`);
      }
    }
    if (candidate.startFallbacks !== undefined && !Array.isArray(candidate.startFallbacks)) {
      throw new Error(`Model-context range substitution rule ${candidate.id} has invalid start fallbacks`);
    }
    const startFallbacks = candidate.startFallbacks ?? [];
    for (const [fallbackIndex, anchor] of startFallbacks.entries()) {
      if (!anchor || !['user', 'assistant'].includes(anchor.role) || !SHA256_RE.test(anchor.textSha256)) {
        throw new Error(
          `Model-context range substitution rule ${candidate.id} has invalid start fallback ${fallbackIndex}`,
        );
      }
    }
    const kinds = candidate.kinds ?? ['stream'];
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => kind !== 'complete' && kind !== 'stream')) {
      throw new Error(`Model-context range substitution rule ${candidate.id} has invalid kinds`);
    }
    if (!candidate.replacement || typeof candidate.replacement.file !== 'string' || !candidate.replacement.file) {
      throw new Error(`Model-context range substitution rule ${candidate.id} has an invalid replacement file`);
    }
    const sourcePath = resolveSourcePath(candidate.replacement.file, configPath);
    const replacementMessages = conversationFromMarkdown(readFileSync(sourcePath, 'utf8'));
    seenIds.add(candidate.id);
    return {
      id: candidate.id,
      kinds: new Set(kinds),
      startAnchors: [candidate.start, ...startFallbacks],
      end: candidate.end,
      replacementMessages,
    };
  });
}

function loadRules(configPath: string): {
  rules: SubstitutionRule[];
  literalRules: LiteralSubstitutionRule[];
  rangeRules: RangeSubstitutionRule[];
} {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<SubstitutionFile>;
  if (raw.schema !== SCHEMA) {
    throw new Error(`Unsupported model-context substitution schema: ${JSON.stringify(raw.schema)}`);
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    throw new Error('Model-context substitution rules must be an array');
  }
  if (raw.literalReplacements !== undefined && !Array.isArray(raw.literalReplacements)) {
    throw new Error('Model-context literal replacements must be an array');
  }
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const rules = (raw.rules ?? []).map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Model-context substitution rule ${index} must be an object`);
    }
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || seenIds.has(candidate.id)) {
      throw new Error(`Model-context substitution rule ${index} has a missing or duplicate id`);
    }
    if (typeof candidate.sha256 !== 'string' || !SHA256_RE.test(candidate.sha256) || seenHashes.has(candidate.sha256)) {
      throw new Error(`Model-context substitution rule ${candidate.id} has an invalid or duplicate sha256`);
    }
    const replacement = resolveReplacement(candidate.replacement, configPath);
    if (!replacement.trim()) {
      throw new Error(`Model-context substitution rule ${candidate.id} resolved to an empty replacement`);
    }
    const kinds = candidate.kinds ?? ['complete', 'stream'];
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => kind !== 'complete' && kind !== 'stream')) {
      throw new Error(`Model-context substitution rule ${candidate.id} has invalid kinds`);
    }
    seenIds.add(candidate.id);
    seenHashes.add(candidate.sha256);
    return {
      id: candidate.id,
      sha256: candidate.sha256,
      kinds: new Set(kinds),
      replacement,
      dropSiblingThinking: candidate.dropSiblingThinking === true,
    };
  });
  const seenLiterals = new Set<string>();
  const literalRules = (raw.literalReplacements ?? []).map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Model-context literal replacement ${index} must be an object`);
    }
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || seenIds.has(candidate.id)) {
      throw new Error(`Model-context literal replacement ${index} has a missing or duplicate id`);
    }
    if (typeof candidate.find !== 'string' || !candidate.find || seenLiterals.has(candidate.find)) {
      throw new Error(`Model-context literal replacement ${candidate.id} has an empty or duplicate find value`);
    }
    if (typeof candidate.replacement !== 'string') {
      throw new Error(`Model-context literal replacement ${candidate.id} has an invalid replacement`);
    }
    const kinds = candidate.kinds ?? ['complete', 'stream'];
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => kind !== 'complete' && kind !== 'stream')) {
      throw new Error(`Model-context literal replacement ${candidate.id} has invalid kinds`);
    }
    seenIds.add(candidate.id);
    seenLiterals.add(candidate.find);
    return {
      id: candidate.id,
      find: candidate.find,
      replacement: candidate.replacement,
      kinds: new Set(kinds),
    };
  });
  const rangeRules = loadRangeRules(raw.ranges, configPath, seenIds);
  if (rules.length + literalRules.length + rangeRules.length === 0) {
    throw new Error('Model-context substitution file must contain at least one rule');
  }
  return { rules, literalRules, rangeRules };
}

function visibleMessageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => visibleMessageText(item)).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if ('content' in record) return visibleMessageText(record.content);
  return '';
}

function anchorMatches(message: unknown, anchor: RangeAnchorFile): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  return record.role === anchor.role && hashText(visibleMessageText(record.content)) === anchor.textSha256;
}

function applyRangeRules(
  input: ProviderRequest['messages'],
  rules: RangeSubstitutionRule[],
  kind: SubstitutionKind | undefined,
  matched: Set<string>,
): ProviderRequest['messages'] {
  let messages = input;
  for (const rule of rules) {
    if (!kind || !rule.kinds.has(kind)) continue;
    const startMatches = rule.startAnchors.map((anchor) =>
      messages.flatMap((message, index) => anchorMatches(message, anchor) ? [index] : []),
    );
    if (startMatches.some((matches) => matches.length > 1)) {
      throw new Error(`Model-context range substitution ${rule.id} has an ambiguous start anchor`);
    }
    const starts = startMatches.find((matches) => matches.length === 1) ?? [];
    const ends = messages.flatMap((message, index) => anchorMatches(message, rule.end) ? [index] : []);
    if (starts.length === 0 && ends.length === 0) continue;
    if (starts.length !== 1 || ends.length !== 1) {
      throw new Error(
        `Model-context range substitution ${rule.id} requires exactly one start and end anchor; ` +
        `found ${starts.length} start(s) and ${ends.length} end(s)`,
      );
    }
    const start = starts[0]!;
    const end = ends[0]!;
    if (start > end) throw new Error(`Model-context range substitution ${rule.id} has reversed anchors`);
    messages = [
      ...messages.slice(0, start),
      ...structuredClone(rule.replacementMessages),
      ...messages.slice(end + 1),
    ];
    matched.add(rule.id);
  }
  return messages;
}

function transformValue(
  value: unknown,
  byHash: Map<string, SubstitutionRule>,
  literalRules: LiteralSubstitutionRule[],
  matched: Set<string>,
  kind?: SubstitutionKind,
): { value: unknown; changed: boolean; dropSiblingThinking: boolean } {
  if (typeof value === 'string') {
    const candidate = byHash.get(hashText(value));
    const rule = candidate && (!kind || candidate.kinds.has(kind)) ? candidate : undefined;
    let output = value;
    let changed = false;
    let dropSiblingThinking = false;
    if (rule) {
      matched.add(rule.id);
      output = rule.replacement;
      changed = true;
      dropSiblingThinking = rule.dropSiblingThinking;
    }
    for (const literalRule of literalRules) {
      if (kind && !literalRule.kinds.has(kind)) continue;
      if (!output.includes(literalRule.find)) continue;
      matched.add(literalRule.id);
      output = output.split(literalRule.find).join(literalRule.replacement);
      changed = true;
    }
    return {
      value: output,
      changed,
      dropSiblingThinking,
    };
  }
  if (Array.isArray(value)) {
    let changed = false;
    let dropSiblingThinking = false;
    const items = value.map((item) => {
      const transformed = transformValue(item, byHash, literalRules, matched, kind);
      changed ||= transformed.changed;
      dropSiblingThinking ||= transformed.dropSiblingThinking;
      return transformed.value;
    });
    const filtered = dropSiblingThinking
      ? items.filter((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
          const type = (item as Record<string, unknown>).type;
          return type !== 'thinking' && type !== 'redacted_thinking';
        })
      : items;
    changed ||= filtered.length !== items.length;
    return { value: changed ? filtered : value, changed, dropSiblingThinking };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    let dropSiblingThinking = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const transformed = transformValue(item, byHash, literalRules, matched, kind);
      output[key] = transformed.value;
      changed ||= transformed.changed;
      dropSiblingThinking ||= transformed.dropSiblingThinking;
    }
    return { value: changed ? output : value, changed, dropSiblingThinking };
  }
  return { value, changed: false, dropSiblingThinking: false };
}

export class ModelContextSubstitutions {
  private readonly byHash: Map<string, SubstitutionRule>;
  private readonly literalRules: LiteralSubstitutionRule[];
  private readonly rangeRules: RangeSubstitutionRule[];

  constructor(
    configPath: string,
    private readonly auditLogPath?: string,
  ) {
    const loaded = loadRules(configPath);
    this.byHash = new Map(loaded.rules.map((rule) => [rule.sha256, rule]));
    this.literalRules = loaded.literalRules;
    this.rangeRules = loaded.rangeRules;
  }

  get ruleCount(): number {
    return this.byHash.size + this.literalRules.length + this.rangeRules.length;
  }

  apply(request: ProviderRequest, kind?: SubstitutionKind): SubstitutionResult {
    const matched = new Set<string>();
    const rangedMessages = applyRangeRules(request.messages, this.rangeRules, kind, matched);
    const transformed = transformValue(rangedMessages, this.byHash, this.literalRules, matched, kind);
    const rangeChanged = rangedMessages !== request.messages;
    const result = transformed.changed
      ? { ...request, messages: transformed.value as unknown[] }
      : rangeChanged ? { ...request, messages: rangedMessages } : request;
    const matchedRuleIds = [...matched];
    if (matchedRuleIds.length > 0 && this.auditLogPath) {
      appendFileSync(this.auditLogPath, JSON.stringify({
        schema: 'connectome-model-context-substitution-event/v1',
        at: new Date().toISOString(),
        kind: kind ?? null,
        matchedRuleIds,
        messageCount: request.messages.length,
        outputMessageCount: result.messages.length,
      }) + '\n', { mode: 0o600 });
    }
    return { request: result, matchedRuleIds };
  }
}

export function loadModelContextSubstitutionsFromEnv(): ModelContextSubstitutions | null {
  const configPath = process.env.MODEL_CONTEXT_SUBSTITUTIONS_FILE;
  if (!configPath) return null;
  return new ModelContextSubstitutions(configPath, process.env.MODEL_CONTEXT_SUBSTITUTIONS_LOG);
}
