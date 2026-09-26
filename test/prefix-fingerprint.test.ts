/**
 * prefixFingerprint: content-free per-block hashes of a raw request, so the
 * cause of a prompt-cache miss can be found by diffing consecutive calls.
 */
import { describe, expect, test } from 'bun:test';
import { prefixFingerprint } from '../src/call-ledger.js';

const req = (edit?: { mark?: number; text?: string }) => ({
  system: [{ type: 'text', text: 'you are someone', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [{ name: 't', description: 'd', input_schema: {} }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello, a private sentence' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: edit?.text ?? 'hi', ...(edit?.mark === 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) },
    ] },
    { role: 'user', content: [{ type: 'text', text: 'more', ...(edit?.mark !== 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) }] },
  ],
});

describe('prefixFingerprint', () => {
  test('hashes only: roles, block types and 12-hex hashes; no text', () => {
    const f = prefixFingerprint(req())!;
    expect(f.messages[1]).toMatch(/^assistant\|thinking,text\|[0-9a-f]{12},[0-9a-f]{12}$/);
    expect(JSON.stringify(f)).not.toContain('private sentence');
    expect(f.breakpoints).toEqual(['system', 'm2.0']);
  });

  test('same request, same fingerprint; a moved breakpoint changes only the markers', () => {
    const a = prefixFingerprint(req())!;
    const b = prefixFingerprint(req({ mark: 1 }))!;
    expect(b.messages).toEqual(a.messages);
    expect(b.breakpoints).toEqual(['system', 'm1.1']);
  });

  test('an edit shows exactly which block changed', () => {
    const a = prefixFingerprint(req())!;
    const b = prefixFingerprint(req({ text: 'hi!' }))!;
    expect(b.messages[0]).toBe(a.messages[0]);
    const [ra, ta, ha] = a.messages[1]!.split('|');
    const [rb, tb, hb] = b.messages[1]!.split('|');
    expect([rb, tb]).toEqual([ra, ta]);
    expect(hb!.split(',')[0]).toBe(ha!.split(',')[0]); // thinking unchanged
    expect(hb!.split(',')[1]).not.toBe(ha!.split(',')[1]); // text changed
  });

  test('not a request: undefined', () => {
    expect(prefixFingerprint(null)).toBeUndefined();
    expect(prefixFingerprint({ messages: 'x' })).toBeUndefined();
  });
});
