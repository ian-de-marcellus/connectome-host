/**
 * PendingNotesModule — operator notes delivered once, at host start.
 *
 * An operator (or the cold-restart watcher) drops markdown files into
 * `<resident>/pending/notes/`. On the next host start each file is added to
 * the agent's context as a single context-only message — the same path the
 * TimeModule's session-start line uses, so it never triggers inference — and
 * is then moved to `pending/delivered/<timestamp>-<name>`. With no files the
 * module does nothing and adds no tools.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
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

export const PENDING_NOTE_PREFIX = '[maintenance note — delivered at restart; no reply needed]';

export interface PendingNotesOptions {
  /** Directory holding `*.md` notes to deliver. */
  notesDir: string;
  /** Where delivered notes are moved (default: sibling `delivered/`). */
  deliveredDir?: string;
  now?: () => Date;
}

export class PendingNotesModule implements Module {
  readonly name = 'pending-notes';
  private readonly notesDir: string;
  private readonly deliveredDir: string;
  private readonly now: () => Date;
  /** Names delivered by the last start(), oldest first (for tests/diagnostics). */
  delivered: string[] = [];

  constructor(options: PendingNotesOptions) {
    this.notesDir = options.notesDir;
    this.deliveredDir = options.deliveredDir ?? join(options.notesDir, '..', 'delivered');
    this.now = options.now ?? (() => new Date());
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.delivered = [];
    if (!existsSync(this.notesDir)) return;
    const files = readdirSync(this.notesDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, path: join(this.notesDir, name), mtime: statSync(join(this.notesDir, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const file of files) {
      const body = readFileSync(file.path, 'utf8').trim();
      if (!body) continue;
      ctx.addMessage('user', [{ type: 'text', text: `${PENDING_NOTE_PREFIX}\n\n${body}` }]);
      mkdirSync(this.deliveredDir, { recursive: true });
      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      renameSync(file.path, join(this.deliveredDir, `${stamp}-${basename(file.name)}`));
      this.delivered.push(file.name);
    }
    if (this.delivered.length > 0) {
      console.error(`[pending-notes] delivered ${this.delivered.length} note(s): ${this.delivered.join(', ')}`);
    }
  }

  async stop(): Promise<void> {}

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'pending-notes has no tools', isError: true };
  }
}
