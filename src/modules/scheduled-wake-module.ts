/**
 * Persistent, resident-controlled scheduled wakes.
 *
 * Timers are only an in-process convenience: the durable source of truth is
 * Chronicle module state. On restart (or when a laptop wakes after a due
 * time), every pending commission is re-armed; overdue recurring work either
 * fires once or advances according to its resident-chosen missed-wake policy.
 */

import { randomUUID } from 'node:crypto';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@animalabs/agent-framework';
import { formatZonedDateTime, resolveTimeZone } from '@animalabs/agent-framework';

const MAX_TIMER_MS = 2_147_000_000;
const MISSED_WAKE_GRACE_MS = 60_000;
const MINUTE_MS = 60_000;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

type Weekday = typeof WEEKDAYS[number];

export interface ScheduledWakeRecurrence {
  frequency: 'daily' | 'weekly';
  localTime: string;
  timeZone: string;
  weekdays?: Weekday[];
  missed: 'fire_once' | 'skip';
}

interface RecurrenceInput {
  frequency?: unknown;
  local_time?: unknown;
  time_zone?: unknown;
  weekdays?: unknown;
  missed?: unknown;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(value: number, timeZone: string): LocalParts {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(value));
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
  };
}

function offsetMinutesAt(value: number, timeZone: string): number {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(value));
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const displayedAsUtc = Date.UTC(
    number('year'),
    number('month') - 1,
    number('day'),
    number('hour'),
    number('minute'),
    number('second'),
  );
  return Math.round((displayedAsUtc - Math.floor(value / 1000) * 1000) / MINUTE_MS);
}

function sameLocalMinute(parts: LocalParts, target: LocalParts): boolean {
  return parts.year === target.year
    && parts.month === target.month
    && parts.day === target.day
    && parts.hour === target.hour
    && parts.minute === target.minute;
}

function sameLocalDate(parts: LocalParts, target: LocalParts): boolean {
  return parts.year === target.year
    && parts.month === target.month
    && parts.day === target.day;
}

/**
 * Resolve one local calendar minute into an instant.
 *
 * On a fall-back overlap the earliest matching instant wins. If a spring-
 * forward transition removes the requested minute, the first valid local
 * minute after it on the same calendar date wins. This makes DST behavior
 * deterministic and keeps a civil-time schedule civil-time based.
 */
function resolveLocalMinute(target: LocalParts, timeZone: string): number | null {
  const wallClockAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
  );
  const offsets = new Set([
    offsetMinutesAt(wallClockAsUtc - 36 * 60 * MINUTE_MS, timeZone),
    offsetMinutesAt(wallClockAsUtc, timeZone),
    offsetMinutesAt(wallClockAsUtc + 36 * 60 * MINUTE_MS, timeZone),
  ]);
  const exact = [...offsets]
    .map((offset) => wallClockAsUtc - offset * MINUTE_MS)
    .filter((candidate) => sameLocalMinute(localParts(candidate, timeZone), target))
    .sort((a, b) => a - b);
  if (exact.length > 0) return exact[0]!;

  // Rare path: a DST gap removed the requested civil minute. Search the
  // surrounding offset envelope for the first later valid minute that still
  // belongs to the requested local date.
  const start = wallClockAsUtc - 18 * 60 * MINUTE_MS;
  const end = wallClockAsUtc + 18 * 60 * MINUTE_MS;
  let best: { instant: number; wallMinute: number } | null = null;
  const requestedWallMinute = target.hour * 60 + target.minute;
  for (let candidate = start; candidate <= end; candidate += MINUTE_MS) {
    const parts = localParts(candidate, timeZone);
    if (!sameLocalDate(parts, target)) continue;
    const wallMinute = parts.hour * 60 + parts.minute;
    if (wallMinute < requestedWallMinute) continue;
    if (!best || wallMinute < best.wallMinute ||
        (wallMinute === best.wallMinute && candidate < best.instant)) {
      best = { instant: candidate, wallMinute };
    }
  }
  return best?.instant ?? null;
}

/** @internal Exported for deterministic calendar/DST regression tests. */
export function nextRecurringOccurrence(
  recurrence: ScheduledWakeRecurrence,
  afterMs: number,
): number {
  const base = localParts(afterMs, recurrence.timeZone);
  const [hourText, minuteText] = recurrence.localTime.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const eligibleWeekdays = new Set(recurrence.weekdays ?? []);

  // A weekly schedule always has an occurrence within seven local dates, but
  // use a larger defensive bound so unusual civil-calendar discontinuities do
  // not turn corrupt persisted state into an infinite loop.
  for (let offset = 0; offset <= 370; offset++) {
    const date = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
    const weekday = WEEKDAYS[date.getUTCDay()]!;
    if (recurrence.frequency === 'weekly' && !eligibleWeekdays.has(weekday)) continue;
    const candidate = resolveLocalMinute({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour,
      minute,
    }, recurrence.timeZone);
    if (candidate !== null && candidate > afterMs) return candidate;
  }
  throw new Error(`Could not resolve the next ${recurrence.frequency} occurrence in ${recurrence.timeZone}.`);
}

function advancePastElapsedOccurrences(
  recurrence: ScheduledWakeRecurrence,
  scheduledForMs: number,
  throughMs: number,
): { nextMs: number; elapsedOccurrences: number } {
  let elapsedOccurrences = 1;
  let cursor = scheduledForMs;
  for (let guard = 0; guard < 100_000; guard++) {
    const nextMs = nextRecurringOccurrence(recurrence, cursor);
    if (nextMs > throughMs) return { nextMs, elapsedOccurrences };
    elapsedOccurrences++;
    cursor = nextMs;
  }
  throw new Error('Recurring wake is more than 100,000 occurrences overdue; refusing an unbounded catch-up scan.');
}

export interface ScheduledWakeModuleConfig {
  timeZone?: string;
  maxPending?: number;
  maxHorizonDays?: number;
}

interface ScheduledWake {
  id: string;
  note: string;
  commissionedAt: string;
  scheduledFor: string;
  status: 'pending' | 'fired' | 'cancelled';
  recurrence?: ScheduledWakeRecurrence;
  occurrencesFired?: number;
  skippedOccurrences?: number;
  coalescedOccurrences?: number;
  firedAt?: string;
  lastSkippedAt?: string;
  lastSkippedScheduledFor?: string;
  cancelledAt?: string;
}

interface ScheduledWakeState {
  wakes: ScheduledWake[];
}

export class ScheduledWakeModule implements Module {
  readonly name = 'scheduled_wake';

  private ctx: ModuleContext | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timeZone: string;
  private readonly maxPending: number;
  private readonly maxHorizonMs: number;
  private state: ScheduledWakeState = { wakes: [] };

  constructor(config: ScheduledWakeModuleConfig = {}) {
    this.timeZone = resolveTimeZone(config.timeZone);
    this.maxPending = config.maxPending ?? 64;
    this.maxHorizonMs = (config.maxHorizonDays ?? 90) * 24 * 60 * 60 * 1000;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.state = ctx.getState<ScheduledWakeState>() ?? { wakes: [] };
    for (const wake of this.state.wakes) {
      if (wake.status !== 'pending') continue;
      if (wake.recurrence?.missed === 'skip' && Date.parse(wake.scheduledFor) <= Date.now()) {
        this.skipMissedWindow(wake);
      } else {
        this.arm(wake);
      }
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'schedule',
        description:
          'Commission a durable one-shot or recurring future wake. It survives host restarts and laptop sleep. ' +
          'For a one-shot wake, give either an absolute ISO-8601 time with an explicit UTC offset (at), or a ' +
          'relative number of minutes (after_minutes). For a recurring wake, give recurrence instead; daily and ' +
          'selected-weekday schedules use local civil time in an IANA timezone and therefore remain at the same ' +
          'wall-clock time across DST. Missed occurrences either coalesce into one wake on return (fire_once, the ' +
          'default) or advance silently (skip). The wake arrives with commissioned/scheduled/fired provenance. ' +
          'Use time--now first when translating human wall-clock language.',
        inputSchema: {
          type: 'object',
          properties: {
            at: {
              type: 'string',
              description: 'Absolute ISO-8601 timestamp including Z or an explicit offset, e.g. 2026-08-30T09:00:00+02:00.',
            },
            after_minutes: {
              type: 'number',
              description: 'Relative delay in minutes; mutually exclusive with at and recurrence.',
            },
            recurrence: {
              type: 'object',
              description:
                'A durable calendar recurrence, mutually exclusive with at and after_minutes. ' +
                'During a spring-forward gap, a nonexistent requested time moves to the first valid minute afterward; ' +
                'during a fall-back overlap, the first occurrence is used.',
              properties: {
                frequency: {
                  type: 'string',
                  enum: ['daily', 'weekly'],
                  description: 'daily, or weekly on the supplied weekdays.',
                },
                local_time: {
                  type: 'string',
                  description: 'Local 24-hour wall-clock time in HH:MM form, e.g. 08:57.',
                },
                time_zone: {
                  type: 'string',
                  description: `IANA timezone, e.g. Europe/Paris. Defaults to the resident runtime timezone (${this.timeZone}).`,
                },
                weekdays: {
                  type: 'array',
                  items: { type: 'string', enum: [...WEEKDAYS] },
                  description: 'Required for weekly schedules; one or more full lowercase weekday names. Omit for daily.',
                },
                missed: {
                  type: 'string',
                  enum: ['fire_once', 'skip'],
                  description:
                    'fire_once (default) delivers one catch-up wake after sleep/offline time, however many occurrences elapsed; ' +
                    'skip advances to the next future occurrence without waking.',
                },
              },
              required: ['frequency', 'local_time'],
            },
            note: {
              type: 'string',
              description: 'The commission/context to return at wake time: what to check, remember, or do.',
            },
          },
          required: ['note'],
        },
      },
      {
        name: 'list',
        description: 'List pending one-shot and recurring wakes, including IDs, next local wall-clock times, recurrence rules, and missed-wake history.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'cancel',
        description: 'Cancel a pending scheduled wake by ID.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Wake ID returned by schedule or list.' } },
          required: ['id'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'list') {
      return {
        success: true,
        data: this.state.wakes
          .filter((wake) => wake.status === 'pending')
          .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))
          .map((wake) => ({
            id: wake.id,
            kind: wake.recurrence ? 'recurring' : 'one-shot',
            note: wake.note,
            scheduledFor: wake.scheduledFor,
            local: formatZonedDateTime(
              new Date(wake.scheduledFor),
              wake.recurrence?.timeZone ?? this.timeZone,
            ),
            commissionedAt: wake.commissionedAt,
            ...(wake.recurrence ? {
              recurrence: wake.recurrence,
              occurrencesFired: wake.occurrencesFired ?? 0,
              skippedOccurrences: wake.skippedOccurrences ?? 0,
              coalescedOccurrences: wake.coalescedOccurrences ?? 0,
              lastFiredAt: wake.firedAt,
              lastSkippedAt: wake.lastSkippedAt,
              lastSkippedScheduledFor: wake.lastSkippedScheduledFor,
            } : {}),
          })),
      };
    }

    if (call.name === 'cancel') {
      const id = (call.input as { id?: unknown })?.id;
      if (typeof id !== 'string' || !id.trim()) return this.error('id (string) is required');
      const wake = this.state.wakes.find((item) => item.id === id && item.status === 'pending');
      if (!wake) return this.error(`No pending scheduled wake with id ${JSON.stringify(id)}.`);
      wake.status = 'cancelled';
      wake.cancelledAt = new Date().toISOString();
      const timer = this.timers.get(wake.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(wake.id);
      this.persist();
      return { success: true, data: `Cancelled scheduled wake ${wake.id}.` };
    }

    if (call.name !== 'schedule') return this.error(`Unknown tool: ${call.name}`);

    const input = call.input as {
      at?: unknown;
      after_minutes?: unknown;
      recurrence?: unknown;
      note?: unknown;
    };
    const note = typeof input?.note === 'string' ? input.note.trim() : '';
    if (!note) return this.error('note (non-empty string) is required');
    const hasAt = input.at !== undefined;
    const hasRelative = input.after_minutes !== undefined;
    const hasRecurrence = input.recurrence !== undefined;
    if (Number(hasAt) + Number(hasRelative) + Number(hasRecurrence) !== 1) {
      return this.error('Provide exactly one of at, after_minutes, or recurrence.');
    }
    if (this.state.wakes.filter((wake) => wake.status === 'pending').length >= this.maxPending) {
      return this.error(`Pending wake limit reached (${this.maxPending}). Cancel one before adding another.`);
    }

    const now = Date.now();
    let dueMs: number;
    let recurrence: ScheduledWakeRecurrence | undefined;
    if (hasAt) {
      if (typeof input.at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.at)) {
        return this.error('at must be an ISO-8601 timestamp with Z or an explicit UTC offset.');
      }
      dueMs = Date.parse(input.at);
      if (!Number.isFinite(dueMs)) return this.error('at is not a valid timestamp.');
    } else if (hasRelative) {
      if (typeof input.after_minutes !== 'number' || !Number.isFinite(input.after_minutes) || input.after_minutes <= 0) {
        return this.error('after_minutes must be a positive number.');
      }
      dueMs = now + input.after_minutes * 60_000;
    } else {
      try {
        recurrence = this.parseRecurrence(input.recurrence);
        dueMs = nextRecurringOccurrence(recurrence, now);
      } catch (error) {
        return this.error(error instanceof Error ? error.message : String(error));
      }
    }
    if (dueMs <= now) return this.error('The scheduled time must be in the future.');
    if (dueMs - now > this.maxHorizonMs) {
      return this.error(`The scheduled time exceeds the ${Math.round(this.maxHorizonMs / 86_400_000)}-day horizon.`);
    }

    const wake: ScheduledWake = {
      id: `wake-${randomUUID().slice(0, 8)}`,
      note,
      commissionedAt: new Date(now).toISOString(),
      scheduledFor: new Date(dueMs).toISOString(),
      status: 'pending',
      ...(recurrence ? {
        recurrence,
        occurrencesFired: 0,
        skippedOccurrences: 0,
        coalescedOccurrences: 0,
      } : {}),
    };
    this.state.wakes.push(wake);
    this.persist();
    this.arm(wake);
    return {
      success: true,
      data: {
        id: wake.id,
        scheduledFor: wake.scheduledFor,
        local: formatZonedDateTime(
          new Date(wake.scheduledFor),
          wake.recurrence?.timeZone ?? this.timeZone,
        ),
        note: wake.note,
        durable: true,
        ...(wake.recurrence ? {
          kind: 'recurring',
          recurrence: wake.recurrence,
        } : { kind: 'one-shot' }),
      },
    };
  }

  private parseRecurrence(value: unknown): ScheduledWakeRecurrence {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('recurrence must be an object.');
    }
    const input = value as RecurrenceInput;
    const allowedKeys = new Set(['frequency', 'local_time', 'time_zone', 'weekdays', 'missed']);
    const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(`Unknown recurrence field${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}.`);
    }
    if (input.frequency !== 'daily' && input.frequency !== 'weekly') {
      throw new Error('recurrence.frequency must be daily or weekly.');
    }
    if (typeof input.local_time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.local_time)) {
      throw new Error('recurrence.local_time must use 24-hour HH:MM form, e.g. 08:57.');
    }
    if (input.time_zone !== undefined &&
        (typeof input.time_zone !== 'string' || !input.time_zone.trim())) {
      throw new Error('recurrence.time_zone must be a non-empty IANA timezone name.');
    }
    const timeZone = resolveTimeZone(
      typeof input.time_zone === 'string' ? input.time_zone : this.timeZone,
    );
    if (input.missed !== undefined && input.missed !== 'fire_once' && input.missed !== 'skip') {
      throw new Error('recurrence.missed must be fire_once or skip.');
    }

    let weekdays: Weekday[] | undefined;
    if (input.frequency === 'weekly') {
      if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
        throw new Error('recurrence.weekdays must contain at least one weekday for a weekly schedule.');
      }
      if (input.weekdays.some((day) => typeof day !== 'string' ||
          !WEEKDAYS.includes(day as Weekday))) {
        throw new Error(`recurrence.weekdays must use full lowercase names: ${WEEKDAYS.join(', ')}.`);
      }
      if (new Set(input.weekdays).size !== input.weekdays.length) {
        throw new Error('recurrence.weekdays must not contain duplicates.');
      }
      weekdays = (input.weekdays as Weekday[])
        .slice()
        .sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    } else if (input.weekdays !== undefined) {
      throw new Error('recurrence.weekdays applies only to weekly schedules; omit it for daily.');
    }

    return {
      frequency: input.frequency,
      localTime: input.local_time,
      timeZone,
      ...(weekdays ? { weekdays } : {}),
      missed: input.missed === 'skip' ? 'skip' : 'fire_once',
    };
  }

  private recurrenceLabel(recurrence: ScheduledWakeRecurrence): string {
    const cadence = recurrence.frequency === 'daily'
      ? 'daily'
      : `weekly on ${recurrence.weekdays!.join(', ')}`;
    return `${cadence} at ${recurrence.localTime} [${recurrence.timeZone}], missed=${recurrence.missed}`;
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'module-event') return {};
    const moduleEvent = event as { type: 'module-event'; source: string; eventType: string; payload: unknown };
    if (moduleEvent.source !== this.name || moduleEvent.eventType !== 'due') return {};
    return { requestInference: true };
  }

  private arm(wake: ScheduledWake): void {
    const prior = this.timers.get(wake.id);
    if (prior) clearTimeout(prior);
    const remaining = Date.parse(wake.scheduledFor) - Date.now();
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_MS));
    const timer = setTimeout(() => {
      this.timers.delete(wake.id);
      if (remaining > MAX_TIMER_MS) this.arm(wake);
      else if (wake.recurrence?.missed === 'skip' &&
          Date.now() - Date.parse(wake.scheduledFor) > MISSED_WAKE_GRACE_MS) {
        this.skipMissedWindow(wake);
      } else {
        this.fire(wake.id);
      }
    }, delay);
    timer.unref?.();
    this.timers.set(wake.id, timer);
  }

  private fire(id: string): void {
    const wake = this.state.wakes.find((item) => item.id === id && item.status === 'pending');
    if (!wake || !this.ctx) return;
    const scheduledFor = wake.scheduledFor;
    const firedAtMs = Date.now();
    wake.firedAt = new Date(firedAtMs).toISOString();

    let nextScheduledFor: string | undefined;
    let coalescedThisWake = 0;
    if (wake.recurrence) {
      const advance = advancePastElapsedOccurrences(
        wake.recurrence,
        Date.parse(scheduledFor),
        firedAtMs,
      );
      coalescedThisWake = advance.elapsedOccurrences - 1;
      wake.occurrencesFired = (wake.occurrencesFired ?? 0) + 1;
      wake.coalescedOccurrences = (wake.coalescedOccurrences ?? 0) + coalescedThisWake;
      nextScheduledFor = new Date(advance.nextMs).toISOString();
      wake.scheduledFor = nextScheduledFor;
    } else {
      wake.status = 'fired';
    }
    this.persist();
    if (wake.recurrence) this.arm(wake);

    const text = [
      '[scheduled-wake]',
      `Commissioned: ${formatZonedDateTime(new Date(wake.commissionedAt), this.timeZone)}`,
      `Scheduled for: ${formatZonedDateTime(
        new Date(scheduledFor),
        wake.recurrence?.timeZone ?? this.timeZone,
      )}`,
      `Fired: ${formatZonedDateTime(new Date(wake.firedAt), this.timeZone)}`,
      ...(wake.recurrence ? [
        `Recurrence: ${this.recurrenceLabel(wake.recurrence)}`,
        `Occurrence delivered: ${wake.occurrencesFired}`,
        ...(coalescedThisWake > 0
          ? [`Missed occurrences coalesced into this wake: ${coalescedThisWake}`]
          : []),
        `Next occurrence: ${formatZonedDateTime(new Date(nextScheduledFor!), wake.recurrence.timeZone)}`,
      ] : []),
      `Commission: ${wake.note}`,
      'This is a durable self-scheduled wake, not a new message from Ian.',
    ].join('\n');
    this.ctx.addMessage('user', [{ type: 'text', text }], {
      source: 'scheduled-wake',
      tags: ['scheduled-wake', 'provenance:commission'],
    });
    this.ctx.pushEvent({
      type: 'module-event',
      source: this.name,
      eventType: 'due',
      payload: {
        id: wake.id,
        recurring: !!wake.recurrence,
        occurrence: wake.occurrencesFired ?? 1,
        scheduledFor,
        nextScheduledFor,
      },
    });
  }

  private skipMissedWindow(wake: ScheduledWake): void {
    if (!wake.recurrence || wake.status !== 'pending') return;
    const now = Date.now();
    const skippedFrom = wake.scheduledFor;
    const advance = advancePastElapsedOccurrences(
      wake.recurrence,
      Date.parse(skippedFrom),
      now,
    );
    wake.skippedOccurrences = (wake.skippedOccurrences ?? 0) + advance.elapsedOccurrences;
    wake.lastSkippedAt = new Date(now).toISOString();
    wake.lastSkippedScheduledFor = skippedFrom;
    wake.scheduledFor = new Date(advance.nextMs).toISOString();
    this.persist();
    this.arm(wake);
  }

  private persist(): void {
    this.ctx?.setState(this.state);
  }

  private error(error: string): ToolResult {
    return { success: false, isError: true, error };
  }
}
