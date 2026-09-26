/**
 * Delivery-queue operations (agent-framework prose outbox), Sol 2026-09-26:
 * /healthz shows what is waiting without content; withdrawal is a WS
 * command (HTTP stays read-only).
 */
import { describe, expect, test } from 'bun:test';
import { buildHealthSnapshot, outboxHealth } from '../src/web/panel-data.js';
import { isClientMessage } from '../src/web/protocol.js';

const NOW = Date.parse('2026-09-26T18:00:00Z');
const status = {
  enabled: true,
  durable: true,
  pending: [
    { id: 'abcdef12-0000-0000-0000-000000000001', conversationId: 'Sol', channelId: 'discord:1:2', writtenAt: NOW - 90_000,
      attempts: 2, outcome: 'not-sent', attachments: 1, tool: 'send_message', expiresAt: NOW + 3_600_000,
      preview: 'the resident\'s own words', lastError: 'x' },
    { id: 'fedcba98-0000-0000-0000-000000000002', conversationId: 'Libby', channelId: 'discord:1:3', writtenAt: NOW - 10_000,
      attempts: 1, outcome: 'unknown', attachments: 0, notice: true, expiresAt: Number.POSITIVE_INFINITY,
      preview: '⚠️ [automatic notice] …', lastError: 'y' },
  ],
  givenUp: [],
};
const app = (s: unknown) => ({
  recipe: {},
  framework: { healthSnapshot: () => ({ agents: [] }), getAllAgents: () => [], getOutboxStatus: () => s },
}) as unknown as Parameters<typeof buildHealthSnapshot>[0];

describe('outbox in /healthz', () => {
  test('content-free summary: ids, where, age, attempts, kept files; no text', () => {
    const h = outboxHealth(app(status), NOW)!;
    expect(h.pending).toBe(2);
    expect(h.byAgent).toEqual({ Sol: 1, Libby: 1 });
    const entries = h.entries as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual({
      id: 'abcdef12', agent: 'Sol', channelId: 'discord:1:2', ageSec: 90, attempts: 2, outcome: 'not-sent',
      attachments: 1, tool: 'send_message', expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
    expect(entries[1]!.notice).toBe(true);
    expect(entries[1]!.expiresAt).toBeNull();
    expect(JSON.stringify(h)).not.toContain('own words');
    expect(JSON.stringify(h)).not.toContain('lastError');
  });

  test('present in the snapshot when enabled; absent otherwise (older framework, or off)', () => {
    expect((buildHealthSnapshot(app(status)) as Record<string, unknown>).proseOutbox).toBeDefined();
    expect((buildHealthSnapshot(app({ enabled: false, durable: false, pending: [], givenUp: [] })) as Record<string, unknown>).proseOutbox).toBeUndefined();
    const older = { recipe: {}, framework: { healthSnapshot: () => ({ agents: [] }), getAllAgents: () => [] } };
    expect((buildHealthSnapshot(older as never) as Record<string, unknown>).proseOutbox).toBeUndefined();
  });
});

describe('outbox-cancel WS message', () => {
  test('parses with an id; rejects without one', () => {
    expect(isClientMessage({ type: 'outbox-cancel', id: 'abcdef12' })).toBe(true);
    expect(isClientMessage({ type: 'outbox-cancel', id: '' })).toBe(false);
    expect(isClientMessage({ type: 'outbox-cancel' })).toBe(false);
  });
});
