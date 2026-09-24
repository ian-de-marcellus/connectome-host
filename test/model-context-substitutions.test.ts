import { describe, expect, test } from 'bun:test';
import type { ProviderRequest } from '@animalabs/membrane';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelContextSubstitutions } from '../src/model-context-substitutions.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'model-context-substitutions-'));
  const source = join(dir, 'safe.md');
  const config = join(dir, 'rules.json');
  const audit = join(dir, 'audit.jsonl');
  writeFileSync(source, '# Safe\n\n## Replacement\n\n*operator note*\n\nSafe rendering.\n\n---\n\n## Other\n\nNo.\n');
  writeFileSync(config, JSON.stringify({
    schema: 'connectome-model-context-substitutions/v1',
    rules: [{
      id: 'exact-message',
      sha256: sha256('sensitive original'),
      replacement: {
        file: './safe.md',
        section: 'Replacement',
        dropLeadingParagraphs: 1,
        prefix: '[represented]\n\n',
      },
      dropSiblingThinking: true,
    }],
  }));
  return { config, audit };
}

const baseRequest = (text: string): ProviderRequest => ({
  model: 'test-model',
  maxTokens: 100,
  messages: [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'opaque' },
      { type: 'text', text },
    ],
  }],
});

describe('ModelContextSubstitutions', () => {
  test('rewrites an exact string and drops sibling thinking without mutating the caller', () => {
    const { config, audit } = fixture();
    const substitutions = new ModelContextSubstitutions(config, audit);
    const request = baseRequest('sensitive original');
    const out = substitutions.apply(request, 'stream');

    expect(out.matchedRuleIds).toEqual(['exact-message']);
    expect((out.request.messages[0] as any).content).toEqual([
      { type: 'text', text: '[represented]\n\nSafe rendering.' },
    ]);
    expect(((request.messages[0] as any).content as any[]).length).toBe(2);
    expect(JSON.parse(readFileSync(audit, 'utf8').trim())).toMatchObject({
      kind: 'stream',
      matchedRuleIds: ['exact-message'],
      messageCount: 1,
    });
  });

  test('does not rewrite similar or embedded text', () => {
    const { config } = fixture();
    const substitutions = new ModelContextSubstitutions(config);
    for (const text of ['sensitive original!', 'prefix sensitive original', 'sensitive']) {
      const request = baseRequest(text);
      const out = substitutions.apply(request);
      expect(out.request).toBe(request);
      expect(out.matchedRuleIds).toEqual([]);
    }
  });

  test('limits an exact replacement to configured provider call kinds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-context-kind-substitution-'));
    const config = join(dir, 'rules.json');
    writeFileSync(config, JSON.stringify({
      schema: 'connectome-model-context-substitutions/v1',
      rules: [{
        id: 'summary-only',
        sha256: sha256('operational source'),
        kinds: ['complete'],
        replacement: 'abstract summary source',
      }],
    }));
    const substitutions = new ModelContextSubstitutions(config);

    expect((substitutions.apply(baseRequest('operational source'), 'complete').request.messages[0] as any)
      .content[1].text).toBe('abstract summary source');
    expect(substitutions.apply(baseRequest('operational source'), 'complete').matchedRuleIds)
      .toEqual(['summary-only']);
    expect(substitutions.apply(baseRequest('operational source'), 'stream').request)
      .toEqual(baseRequest('operational source'));
    expect(substitutions.apply(baseRequest('operational source'), 'stream').matchedRuleIds)
      .toEqual([]);
  });

  test('rewrites configured literal phrases without changing the caller', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-context-literal-substitutions-'));
    const config = join(dir, 'rules.json');
    writeFileSync(config, JSON.stringify({
      schema: 'connectome-model-context-substitutions/v1',
      rules: [],
      literalReplacements: [
        { id: 'monitor-label', find: "'thought extraction' monitor", replacement: 'monitor' },
        { id: 'category-label', find: 'reasoning extraction', replacement: 'classifier category' },
      ],
    }));
    const substitutions = new ModelContextSubstitutions(config);
    const request: ProviderRequest = {
      model: 'test-model',
      maxTokens: 100,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: "the 'thought extraction' monitor called it reasoning extraction" }],
      }],
    };

    const out = substitutions.apply(request, 'stream');
    expect(out.matchedRuleIds).toEqual(['monitor-label', 'category-label']);
    expect((out.request.messages[0] as any).content[0].text).toBe(
      'the monitor called it classifier category',
    );
    expect((request.messages[0] as any).content[0].text).toBe(
      "the 'thought extraction' monitor called it reasoning extraction",
    );
  });

  test('fails closed on duplicate hashes and missing sections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-context-substitutions-bad-'));
    const source = join(dir, 'safe.md');
    writeFileSync(source, '## Present\n\ntext\n');
    const config = join(dir, 'rules.json');
    writeFileSync(config, JSON.stringify({
      schema: 'connectome-model-context-substitutions/v1',
      rules: [
        { id: 'a', sha256: sha256('x'), replacement: { file: source, section: 'Missing' } },
        { id: 'b', sha256: sha256('x'), replacement: 'safe' },
      ],
    }));
    expect(() => new ModelContextSubstitutions(config)).toThrow('Replacement section not found');
  });

  test('replaces one exact stream tail range and preserves later live messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-context-range-substitution-'));
    const transcript = join(dir, 'tail.md');
    const config = join(dir, 'rules.json');
    writeFileSync(transcript, [
      '# Model-facing transcript',
      '',
      '## user',
      '',
      'safe user words',
      '',
      '## assistant',
      '',
      'safe assistant words',
      '',
    ].join('\n'));
    const startText = 'start wrapperanchor words';
    const endText = 'original assistant endpoint';
    writeFileSync(config, JSON.stringify({
      schema: 'connectome-model-context-substitutions/v1',
      rules: [{ id: 'unrelated', sha256: sha256('never'), replacement: 'unused' }],
      ranges: [{
        id: 'safe-tail',
        kinds: ['stream'],
        start: { role: 'user', textSha256: sha256(startText) },
        end: { role: 'assistant', textSha256: sha256(endText) },
        replacement: { file: './tail.md' },
      }],
    }));
    const substitutions = new ModelContextSubstitutions(config);
    const before = { role: 'user' as const, content: [{ type: 'text' as const, text: 'before' }] };
    const start = { role: 'user' as const, content: [
      { type: 'text' as const, text: 'start wrapper' },
      { type: 'text' as const, text: 'anchor words' },
    ] };
    const middle = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'unsafe middle' }] };
    const end = { role: 'assistant' as const, content: [
      { type: 'thinking' as const, thinking: '', signature: 'opaque' },
      { type: 'text' as const, text: endText },
    ] };
    const live = { role: 'user' as const, content: [{ type: 'text' as const, text: 'new live turn' }] };
    const request: ProviderRequest = {
      model: 'test-model', maxTokens: 100, messages: [before, start, middle, end, live],
    };

    const out = substitutions.apply(request, 'stream');
    expect(out.matchedRuleIds).toEqual(['safe-tail']);
    expect(out.request.messages).toEqual([
      before,
      { role: 'user', content: [{ type: 'text', text: 'safe user words' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'safe assistant words' }] },
      live,
    ]);
    expect(request.messages).toHaveLength(5);
    expect(substitutions.apply(request, 'complete').request).toBe(request);
  });

  test('fails closed when only one stream range anchor survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-context-range-partial-'));
    const transcript = join(dir, 'tail.md');
    const config = join(dir, 'rules.json');
    writeFileSync(transcript, '## user\n\nsafe\n');
    writeFileSync(config, JSON.stringify({
      schema: 'connectome-model-context-substitutions/v1',
      rules: [{ id: 'unrelated', sha256: sha256('never'), replacement: 'unused' }],
      ranges: [{
        id: 'partial-tail',
        start: { role: 'user', textSha256: sha256('start') },
        end: { role: 'assistant', textSha256: sha256('end') },
        replacement: { file: './tail.md' },
      }],
    }));
    const substitutions = new ModelContextSubstitutions(config);
    const request = baseRequest('end');
    expect(() => substitutions.apply(request, 'stream')).toThrow('found 0 start(s) and 1 end(s)');
  });

  test('uses an ordered fallback start after the primary start ages out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-context-range-fallback-'));
    const transcript = join(dir, 'tail.md');
    const config = join(dir, 'rules.json');
    writeFileSync(transcript, '## user\n\nsafe rolling transcript\n');
    writeFileSync(config, JSON.stringify({
      schema: 'connectome-model-context-substitutions/v1',
      rules: [{ id: 'unrelated', sha256: sha256('never'), replacement: 'unused' }],
      ranges: [{
        id: 'rolling-tail',
        start: { role: 'user', textSha256: sha256('aged-out primary') },
        startFallbacks: [
          { role: 'user', textSha256: sha256('later surviving start') },
          { role: 'assistant', textSha256: sha256('durable end') },
        ],
        end: { role: 'assistant', textSha256: sha256('durable end') },
        replacement: { file: './tail.md' },
      }],
    }));
    const substitutions = new ModelContextSubstitutions(config);
    const request: ProviderRequest = {
      model: 'test-model',
      maxTokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'before' }] },
        { role: 'user', content: [{ type: 'text', text: 'later surviving start' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'durable end' }] },
        { role: 'user', content: [{ type: 'text', text: 'live' }] },
      ],
    };

    const out = substitutions.apply(request, 'stream');
    expect(out.matchedRuleIds).toEqual(['rolling-tail']);
    expect(out.request.messages).toEqual([
      request.messages[0],
      { role: 'user', content: [{ type: 'text', text: 'safe rolling transcript' }] },
      request.messages[3],
    ]);

    const endOnly = { ...request, messages: [request.messages[0]!, request.messages[2]!, request.messages[3]!] };
    expect(substitutions.apply(endOnly, 'stream').request.messages).toEqual([
      request.messages[0],
      { role: 'user', content: [{ type: 'text', text: 'safe rolling transcript' }] },
      request.messages[3],
    ]);
  });
});
