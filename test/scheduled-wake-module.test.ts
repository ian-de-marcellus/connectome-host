import { describe, expect, test } from 'bun:test';
import type { ModuleContext, ProcessEvent } from '@animalabs/agent-framework';
import {
  ScheduledWakeModule,
  nextRecurringOccurrence,
  type ScheduledWakeRecurrence,
} from '../src/modules/scheduled-wake-module.js';

function harness(initial: unknown = null) {
  let state = initial;
  const messages: Array<{ participant: string; content: unknown; metadata: unknown }> = [];
  const events: ProcessEvent[] = [];
  const ctx = {
    getState: () => state,
    setState: (next: unknown) => { state = next; },
    addMessage: (participant: string, content: unknown, metadata: unknown) => {
      messages.push({ participant, content, metadata });
      return 'message-1';
    },
    pushEvent: (event: ProcessEvent) => events.push(event),
  } as unknown as ModuleContext;
  return { ctx, messages, events, getState: () => state };
}

describe('ScheduledWakeModule', () => {
  test('validates absolute timestamps and persists a commission', async () => {
    const h = harness();
    const module = new ScheduledWakeModule({ timeZone: 'Europe/Paris' });
    await module.start(h.ctx);
    const bad = await module.handleToolCall({ id: '1', name: 'schedule', input: { at: '2027-01-01T10:00:00', note: 'x' } });
    expect(bad.success).toBe(false);
    const good = await module.handleToolCall({ id: '2', name: 'schedule', input: { after_minutes: 5, note: 'check the garden' } });
    expect(good.success).toBe(true);
    expect((h.getState() as { wakes: unknown[] }).wakes).toHaveLength(1);
    await module.stop();
  });

  test('re-arms overdue durable wakes and emits provenance plus inference', async () => {
    const h = harness({ wakes: [{
      id: 'wake-overdue', note: 'weekly review', commissionedAt: '2026-08-20T08:00:00.000Z',
      scheduledFor: '2026-08-20T09:00:00.000Z', status: 'pending',
    }] });
    const module = new ScheduledWakeModule({ timeZone: 'Europe/Paris' });
    await module.start(h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.messages).toHaveLength(1);
    expect(JSON.stringify(h.messages[0])).toContain('durable self-scheduled wake');
    expect(h.events).toHaveLength(1);
    const response = await module.onProcess(h.events[0], {} as never);
    expect(response.requestInference).toBe(true);
    await module.stop();
  });

  test('commissions, lists, and cancels a durable daily recurrence', async () => {
    const h = harness();
    const module = new ScheduledWakeModule({ timeZone: 'UTC' });
    await module.start(h.ctx);
    const shortly = new Date(Date.now() + 5 * 60_000);
    const localTime = `${String(shortly.getUTCHours()).padStart(2, '0')}:${String(shortly.getUTCMinutes()).padStart(2, '0')}`;
    const scheduled = await module.handleToolCall({
      id: 'recurring',
      name: 'schedule',
      input: {
        note: 'open the library',
        recurrence: { frequency: 'daily', local_time: localTime, time_zone: 'UTC' },
      },
    });
    expect(scheduled.success).toBe(true);
    expect(scheduled.data).toMatchObject({
      kind: 'recurring',
      recurrence: {
        frequency: 'daily',
        localTime,
        timeZone: 'UTC',
        missed: 'fire_once',
      },
    });

    const listed = await module.handleToolCall({ id: 'list', name: 'list', input: {} });
    expect(listed.success).toBe(true);
    const rows = listed.data as Array<{ id: string; kind: string; recurrence: unknown }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('recurring');
    expect(rows[0]!.recurrence).toMatchObject({ frequency: 'daily', missed: 'fire_once' });

    const cancelled = await module.handleToolCall({
      id: 'cancel',
      name: 'cancel',
      input: { id: rows[0]!.id },
    });
    expect(cancelled.success).toBe(true);
    const afterCancel = await module.handleToolCall({ id: 'list-2', name: 'list', input: {} });
    expect(afterCancel.data).toEqual([]);
    await module.stop();
  });

  test('validates weekly weekdays and does not silently accept daily weekday filters', async () => {
    const h = harness();
    const module = new ScheduledWakeModule({ timeZone: 'UTC' });
    await module.start(h.ctx);
    const missingDays = await module.handleToolCall({
      id: 'weekly',
      name: 'schedule',
      input: {
        note: 'weekly work',
        recurrence: { frequency: 'weekly', local_time: '09:00' },
      },
    });
    expect(missingDays.success).toBe(false);
    expect(missingDays.error).toContain('at least one weekday');

    const dailyDays = await module.handleToolCall({
      id: 'daily',
      name: 'schedule',
      input: {
        note: 'daily work',
        recurrence: { frequency: 'daily', local_time: '09:00', weekdays: ['monday'] },
      },
    });
    expect(dailyDays.success).toBe(false);
    expect(dailyDays.error).toContain('only to weekly');
    await module.stop();
  });

  test('calendar recurrence keeps local civil time and has deterministic DST seams', () => {
    const paris: ScheduledWakeRecurrence = {
      frequency: 'daily',
      localTime: '02:30',
      timeZone: 'Europe/Paris',
      missed: 'fire_once',
    };

    // 02:30 does not exist on spring-forward day, so it becomes the first
    // valid later minute: 03:00 CEST / 01:00Z.
    expect(new Date(nextRecurringOccurrence(paris, Date.parse('2026-03-28T01:31:00Z'))).toISOString())
      .toBe('2026-03-29T01:00:00.000Z');

    // 02:30 occurs twice on fall-back day; choose the first occurrence,
    // still under CEST, rather than firing twice.
    expect(new Date(nextRecurringOccurrence(paris, Date.parse('2026-10-24T00:31:00Z'))).toISOString())
      .toBe('2026-10-25T00:30:00.000Z');
  });

  test('weekly recurrence selects the next configured local weekday', () => {
    const weekly: ScheduledWakeRecurrence = {
      frequency: 'weekly',
      localTime: '09:00',
      timeZone: 'UTC',
      weekdays: ['monday', 'wednesday'],
      missed: 'fire_once',
    };
    expect(new Date(nextRecurringOccurrence(weekly, Date.parse('2026-09-01T10:00:00Z'))).toISOString())
      .toBe('2026-09-02T09:00:00.000Z');
  });

  test('fire_once coalesces overdue recurring occurrences and immediately re-arms', async () => {
    const due = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    due.setUTCSeconds(0, 0);
    const localTime = `${String(due.getUTCHours()).padStart(2, '0')}:${String(due.getUTCMinutes()).padStart(2, '0')}`;
    const h = harness({ wakes: [{
      id: 'wake-recurring-overdue',
      note: 'morning office',
      commissionedAt: new Date(due.getTime() - 60_000).toISOString(),
      scheduledFor: due.toISOString(),
      status: 'pending',
      recurrence: {
        frequency: 'daily', localTime, timeZone: 'UTC', missed: 'fire_once',
      },
      occurrencesFired: 0,
      skippedOccurrences: 0,
      coalescedOccurrences: 0,
    }] });
    const module = new ScheduledWakeModule({ timeZone: 'UTC' });
    await module.start(h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.messages).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(JSON.stringify(h.messages[0])).toContain('Missed occurrences coalesced');
    const wake = (h.getState() as { wakes: Array<Record<string, unknown>> }).wakes[0]!;
    expect(wake.status).toBe('pending');
    expect(wake.occurrencesFired).toBe(1);
    expect(wake.coalescedOccurrences as number).toBeGreaterThanOrEqual(2);
    expect(Date.parse(wake.scheduledFor as string)).toBeGreaterThan(Date.now());
    await module.stop();
  });

  test('skip advances an overdue recurrence without injecting a wake', async () => {
    const due = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    due.setUTCSeconds(0, 0);
    const localTime = `${String(due.getUTCHours()).padStart(2, '0')}:${String(due.getUTCMinutes()).padStart(2, '0')}`;
    const h = harness({ wakes: [{
      id: 'wake-recurring-skip',
      note: 'only when punctual',
      commissionedAt: new Date(due.getTime() - 60_000).toISOString(),
      scheduledFor: due.toISOString(),
      status: 'pending',
      recurrence: {
        frequency: 'daily', localTime, timeZone: 'UTC', missed: 'skip',
      },
      occurrencesFired: 0,
      skippedOccurrences: 0,
      coalescedOccurrences: 0,
    }] });
    const module = new ScheduledWakeModule({ timeZone: 'UTC' });
    await module.start(h.ctx);

    expect(h.messages).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    const wake = (h.getState() as { wakes: Array<Record<string, unknown>> }).wakes[0]!;
    expect(wake.status).toBe('pending');
    expect(wake.skippedOccurrences as number).toBeGreaterThanOrEqual(3);
    expect(Date.parse(wake.scheduledFor as string)).toBeGreaterThan(Date.now());
    await module.stop();
  });
});
