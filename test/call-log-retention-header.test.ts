/** Every call log opens with a record of what it keeps and discards, and why. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';

test('the first line declares retained vs omitted, with the reason; it is not a call record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-log-'));
  try {
    const path = join(dir, 'llm-calls.test.jsonl');
    new LoggingAnthropicAdapter({ apiKey: 'x' } as never, path);
    const first = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!);
    expect(first.type).toBe('log-header');
    expect(first.kind).toBeUndefined();
    expect(first.omitted.join(' ')).toContain('request bodies');
    expect(first.why).toContain('out-of-memory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
