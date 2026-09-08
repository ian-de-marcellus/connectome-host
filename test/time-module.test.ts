import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import { formatNow, TimeModule } from '../src/modules/time-module.js';

describe('TimeModule presentation timezone', () => {
  test('formats current time independently of the host timezone', () => {
    expect(formatNow(new Date('2026-07-15T12:34:56.789Z'), 'America/Los_Angeles')).toEqual({
      iso: '2026-07-15T05:34:56.789-07:00',
      local: '2026-07-15T05:34:56.789-07:00 [America/Los_Angeles]',
      timezone: 'America/Los_Angeles',
      unixMs: 1_784_118_896_789,
    });
  });

  test('can suppress the synthetic start message while retaining durable start state', async () => {
    const messages: unknown[] = [];
    let state: unknown;
    const context = {
      getState: () => state,
      addMessage: (...args: unknown[]) => messages.push(args),
      setState: (next: unknown) => { state = next; },
    } as unknown as ModuleContext;

    const module = new TimeModule('Europe/Paris', { announceSessionStart: false });
    await module.start(context);

    expect(messages).toEqual([]);
    expect(state).toEqual({ sessionStartAnnounced: true });
    expect(module.getTools().map((tool) => tool.name)).toContain('now');
  });
});
