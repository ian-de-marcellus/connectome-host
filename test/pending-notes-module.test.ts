import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import type { Membrane } from '@animalabs/membrane';
import { PENDING_NOTE_PREFIX, PendingNotesModule } from '../src/modules/pending-notes-module.js';
import { createFramework } from '../src/index.js';
import { SettingsModule } from '../src/modules/settings-module.js';
import { validateRecipe } from '../src/recipe.js';

function fakeCtx() {
  const messages: Array<[string, Array<{ type: string; text: string }>]> = [];
  const ctx = { addMessage: (p: string, c: Array<{ type: string; text: string }>) => { messages.push([p, c]); } } as unknown as ModuleContext;
  return { ctx, messages };
}

describe('PendingNotesModule', () => {
  test('no directory or no files: does nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-'));
    const { ctx, messages } = fakeCtx();
    await new PendingNotesModule({ notesDir: join(dir, 'pending', 'notes') }).start(ctx);
    expect(messages).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('delivers each note oldest first with the prefix, then moves it to delivered/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-'));
    const notes = join(dir, 'pending', 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'b.md'), 'second note');
    writeFileSync(join(notes, 'a.md'), 'first note');
    utimesSync(join(notes, 'a.md'), new Date('2026-09-24T10:00:00Z'), new Date('2026-09-24T10:00:00Z'));
    utimesSync(join(notes, 'b.md'), new Date('2026-09-24T11:00:00Z'), new Date('2026-09-24T11:00:00Z'));
    writeFileSync(join(notes, 'ignored.txt'), 'not markdown');
    const { ctx, messages } = fakeCtx();
    const mod = new PendingNotesModule({ notesDir: notes, now: () => new Date('2026-09-24T12:00:00Z') });
    await mod.start(ctx);
    expect(messages.map(([, c]) => c[0].text)).toEqual([`${PENDING_NOTE_PREFIX}\n\nfirst note`, `${PENDING_NOTE_PREFIX}\n\nsecond note`]);
    expect(readdirSync(notes)).toEqual(['ignored.txt']);
    expect(readdirSync(join(dir, 'pending', 'delivered')).sort()).toEqual([
      '2026-09-24T12-00-00-000Z-a.md', '2026-09-24T12-00-00-000Z-b.md',
    ]);
    // Idempotent: a second start delivers nothing.
    const again = fakeCtx();
    await mod.start(again.ctx);
    expect(again.messages).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a real framework start stores the note without any inference', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pn-host-'));
    const storePath = join(root, 'data', 'sessions', 's1');
    mkdirSync(join(root, 'data', 'sessions'), { recursive: true });
    const notes = join(root, 'pending', 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'hello.md'), 'Memory consolidation has resumed.');
    let membraneCalls = 0;
    const membrane = new Proxy({}, {
      get: (_t, p) => p === 'then' ? undefined : () => { membraneCalls++; throw new Error(`membrane.${String(p)} must not be called`); },
    }) as unknown as Membrane;
    const recipe = validateRecipe({
      name: 'pending-notes-test',
      agent: { name: 'resident', model: 'claude-sonnet-5', systemPrompt: 'test' },
      modules: { wake: false },
    });
    const fw = await createFramework(membrane, storePath, recipe, 'resident', new SettingsModule(), null, null);
    fw.start();
    await new Promise((r) => setTimeout(r, 300));
    const texts = (fw.getAgent('resident') as any).getContextManager().getAllMessages()
      .flatMap((m: any) => (m.content ?? []).map((b: any) => b.text ?? ''));
    expect(texts.some((t: string) => t.startsWith(PENDING_NOTE_PREFIX) && t.includes('Memory consolidation has resumed.'))).toBe(true);
    expect(membraneCalls).toBe(0);
    expect(existsSync(join(notes, 'hello.md'))).toBe(false);
    await fw.stop();
    rmSync(root, { recursive: true, force: true });
  });
});
