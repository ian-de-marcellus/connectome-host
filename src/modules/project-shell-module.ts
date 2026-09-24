/**
 * A deliberately narrow command workspace for resident-owned projects.
 *
 * Every command runs under macOS Seatbelt with a minimal environment, no
 * network, and file access limited to explicitly configured roots plus a
 * private scratch directory.  The policy is inherited by child processes.
 */

import { mkdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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

export interface ProjectShellRoot {
  name: string;
  path: string;
  description?: string;
  /** Mount-relative paths that remain unavailable even though their parent
   *  root is command-capable. Used for private subtrees inside a shared
   *  project (for example another resident's diary). */
  exclude?: string[];
}

export interface ProjectShellModuleConfig {
  roots: ProjectShellRoot[];
  scratchPath: string;
  /** Additional tool/runtime trees that commands may read and execute but
   *  never modify. This keeps application bundles available without making
   *  all of /Applications visible to the resident. */
  readOnlyPaths?: string[];
  timeoutMs?: number;
  /** Allow the resident to opt an individual command out of the deadline.
   *  Defaults to false. This is intentionally separate from timeoutMs so a
   *  deployment can keep a finite ordinary default while permitting known
   *  long-running work such as OCR. */
  allowNoTimeout?: boolean;
  maxOutputChars?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
}

function sbQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Seatbelt's `(subpath ...)` permission does not grant metadata access to the
 * path's ancestors. Most system paths have that access through system.sb, but
 * Homebrew's `/opt/homebrew` tree does not. Allowing metadata on the literal
 * ancestor directories is enough for realpath(3) to resolve an executable
 * symlink without granting read access to sibling directory contents.
 */
function literalAncestors(paths: string[]): string[] {
  const ancestors = new Set<string>();
  for (const path of paths) {
    let current = resolve(path);
    while (true) {
      const parent = dirname(current);
      if (parent === current) break;
      if (parent !== '/') ancestors.add(parent);
      current = parent;
    }
  }
  return [...ancestors].sort();
}

export class ProjectShellModule implements Module {
  readonly name = 'project_shell';

  private readonly roots: Array<ProjectShellRoot & { excludedPaths: string[] }>;
  private scratchPath: string;
  private readonly readOnlyPaths: string[];
  private readonly timeoutMs: number;
  private readonly allowNoTimeout: boolean;
  private readonly maxOutputChars: number;

  constructor(config: ProjectShellModuleConfig) {
    this.roots = config.roots.map((root) => ({
      ...root,
      path: resolve(root.path),
      exclude: [...(root.exclude ?? [])],
      excludedPaths: [],
    }));
    this.scratchPath = resolve(config.scratchPath);
    this.readOnlyPaths = (config.readOnlyPaths ?? []).map((path) => resolve(path));
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.allowNoTimeout = config.allowNoTimeout ?? false;
    this.maxOutputChars = config.maxOutputChars ?? 80_000;
  }

  async start(_ctx: ModuleContext): Promise<void> {
    await mkdir(this.scratchPath, { recursive: true, mode: 0o700 });
    // Seatbelt matches canonical filesystem paths. In particular, macOS's
    // /var -> /private/var indirection otherwise makes an apparently allowed
    // temp/root path fail at runtime.
    this.scratchPath = await realpath(this.scratchPath);
    for (let index = 0; index < this.readOnlyPaths.length; index += 1) {
      this.readOnlyPaths[index] = await realpath(this.readOnlyPaths[index]);
    }
    for (const root of this.roots) {
      root.path = await realpath(root.path);
      root.excludedPaths = [];
      for (const excludedRelativePath of root.exclude ?? []) {
        const candidate = resolve(root.path, excludedRelativePath);
        const rel = relative(root.path, candidate);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`Excluded path must name a proper descendant of ${root.name}: ${excludedRelativePath}`);
        }
        try {
          root.excludedPaths.push(await realpath(candidate));
        } catch {
          // Keep a future path excluded even when it does not exist yet.
          root.excludedPaths.push(candidate);
        }
      }
    }
  }

  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    const roots = this.roots.map((root) => {
      const exclusions = root.exclude?.length ? ` (excluding ${root.exclude.join(', ')})` : '';
      return `${root.name} → ${root.path}${exclusions}`;
    }).join('; ');
    const deadlineDescription = this.allowNoTimeout
      ? `Commands normally stop after ${this.describeDuration(this.timeoutMs)}. For deliberately long work, ` +
        'timeout_mode="none" removes that deadline; the call then waits until the command exits or the Host stops.'
      : `Commands stop after ${this.describeDuration(this.timeoutMs)}.`;
    return [
      {
        name: 'run',
        description:
          'Run a bash command inside one explicitly mounted project root. Child commands inherit a ' +
          'filesystem sandbox: they may write only the mounted roots and private scratch, and may also ' +
          'read and execute explicitly configured tool runtimes, ' +
          `and have no network access. ${deadlineDescription} Prefer reversible curation (move uncertain removals into a ` +
          'clearly named holding/trash folder); do not delete or overwrite valuable material without ' +
          `Ian's explicit authorization. Available roots: ${roots}`,
        inputSchema: {
          type: 'object',
          properties: {
            root: { type: 'string', enum: this.roots.map((item) => item.name) },
            command: { type: 'string', description: 'Command to run under /bin/bash --noprofile --norc -lc.' },
            cwd: {
              type: 'string',
              description: 'Optional directory relative to the selected root (default: root). Absolute paths and .. escapes are rejected.',
            },
            ...(this.allowNoTimeout ? {
              timeout_mode: {
                type: 'string',
                enum: ['default', 'none'],
                description:
                  'default uses the configured command deadline. none disables it for this call; use only for deliberately long work because the tool remains occupied until the process exits or the Host stops.',
              },
            } : {}),
          },
          required: ['root', 'command'],
        },
      },
      {
        name: 'roots',
        description: 'List the command-capable project roots and their intended use.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'roots') {
      return {
        success: true,
        data: this.roots.map((root) => ({
          name: root.name,
          path: root.path,
          description: root.description ?? null,
          access: 'read-write, command-capable, no network',
          commandTimeout: {
            defaultMs: this.timeoutMs,
            defaultHuman: this.describeDuration(this.timeoutMs),
            noTimeoutAvailable: this.allowNoTimeout,
            noTimeoutInput: this.allowNoTimeout ? { timeout_mode: 'none' } : null,
          },
          excluded: root.exclude ?? [],
          readOnlyToolPaths: this.readOnlyPaths,
        })),
      };
    }
    if (call.name !== 'run') return this.error(`Unknown tool: ${call.name}`);

    const input = call.input as {
      root?: unknown;
      command?: unknown;
      cwd?: unknown;
      timeout_mode?: unknown;
    };
    const root = this.roots.find((item) => item.name === input?.root);
    if (!root) return this.error(`root must be one of: ${this.roots.map((item) => item.name).join(', ')}`);
    if (typeof input.command !== 'string' || !input.command.trim()) {
      return this.error('command (non-empty string) is required');
    }
    if (input.cwd !== undefined && typeof input.cwd !== 'string') return this.error('cwd must be a string');
    if (typeof input.cwd === 'string' && isAbsolute(input.cwd)) return this.error('cwd must be relative to the selected root');
    if (input.timeout_mode !== undefined && input.timeout_mode !== 'default' && input.timeout_mode !== 'none') {
      return this.error('timeout_mode must be "default" or "none"');
    }
    if (input.timeout_mode === 'none' && !this.allowNoTimeout) {
      return this.error('This residence does not permit commands without a timeout.');
    }

    let canonicalRoot: string;
    let cwd: string;
    try {
      canonicalRoot = await realpath(root.path);
      cwd = await realpath(resolve(canonicalRoot, (input.cwd as string | undefined) ?? '.'));
    } catch (err) {
      return this.error(`Cannot resolve root/cwd: ${(err as Error).message}`);
    }
    const rel = relative(canonicalRoot, cwd);
    if (rel.startsWith('..') || isAbsolute(rel)) return this.error('cwd escapes the selected root');
    if (root.excludedPaths.some((excludedPath) => {
      const excludedRel = relative(excludedPath, cwd);
      return excludedRel === '' || (!excludedRel.startsWith('..') && !isAbsolute(excludedRel));
    })) {
      return this.error('cwd is inside an excluded private subtree');
    }

    const effectiveTimeoutMs = input.timeout_mode === 'none' ? null : this.timeoutMs;
    const result = await this.runSandboxed(input.command, cwd, effectiveTimeoutMs);
    return {
      success: result.exitCode === 0 && !result.timedOut,
      isError: result.exitCode !== 0 || result.timedOut || undefined,
      data: {
        root: root.name,
        cwd: rel ? `${root.name}/${rel}` : root.name,
        ...result,
      },
      ...(result.timedOut ? { error: `Command exceeded ${effectiveTimeoutMs} ms and was terminated.` } : {}),
    };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  private sandboxProfile(): string {
    const readableExecutables = ['/bin', '/usr/bin', '/usr/local', '/opt/homebrew'];
    const readablePaths = [
      ...readableExecutables,
      ...this.readOnlyPaths,
      ...this.roots.map((root) => root.path),
      this.scratchPath,
    ];
    const readRules = readablePaths
      .map((path) => `(subpath ${sbQuote(path)})`)
      .join(' ');
    const ancestorRules = literalAncestors(readablePaths)
      .map((path) => `(literal ${sbQuote(path)})`)
      .join(' ');
    const writeRules = [...this.roots.map((root) => root.path), this.scratchPath]
      .map((path) => `(subpath ${sbQuote(path)})`)
      .join(' ');
    const denyRules = this.roots.flatMap((root) => root.excludedPaths)
      .map((path) => `(deny file-read* file-write* file-test-existence file-map-executable (subpath ${sbQuote(path)}))`);
    return [
      '(version 1)',
      '(deny default)',
      '(import "system.sb")',
      '(deny network*)',
      '(allow process-exec)',
      '(allow process-fork)',
      `(allow file-read-metadata ${ancestorRules})`,
      `(allow file-read* file-test-existence file-map-executable ${readRules})`,
      `(allow file-write* ${writeRules})`,
      ...denyRules,
    ].join('');
  }

  private runSandboxed(command: string, cwd: string, timeoutMs: number | null): Promise<RunResult> {
    return new Promise((resolvePromise) => {
      const child = spawn(
        '/usr/bin/sandbox-exec',
        ['-p', this.sandboxProfile(), '/bin/bash', '--noprofile', '--norc', '-lc', command],
        {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            HOME: this.scratchPath,
            TMPDIR: this.scratchPath,
            PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
          },
        },
      );

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        const current = target === 'stdout' ? stdout : stderr;
        if (current.length >= this.maxOutputChars) { truncated = true; return; }
        const next = current + chunk.toString('utf8');
        if (next.length > this.maxOutputChars) truncated = true;
        if (target === 'stdout') stdout = next.slice(0, this.maxOutputChars);
        else stderr = next.slice(0, this.maxOutputChars);
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      const timeout = timeoutMs === null ? null : setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
        setTimeout(() => {
          try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
        }, 2_000).unref();
      }, timeoutMs);
      timeout?.unref();

      child.once('error', (err) => {
        if (timeout) clearTimeout(timeout);
        resolvePromise({ stdout, stderr: `${stderr}${err.message}`, exitCode: null, signal: null, timedOut, truncated });
      });
      child.once('close', (exitCode, signal) => {
        if (timeout) clearTimeout(timeout);
        resolvePromise({ stdout, stderr, exitCode, signal, timedOut, truncated });
      });
    });
  }

  private describeDuration(ms: number): string {
    if (ms % 3_600_000 === 0) {
      const hours = ms / 3_600_000;
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    if (ms % 60_000 === 0) {
      const minutes = ms / 60_000;
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    if (ms % 1_000 === 0) {
      const seconds = ms / 1_000;
      return `${seconds} second${seconds === 1 ? '' : 's'}`;
    }
    return `${ms} ms`;
  }

  private error(error: string): ToolResult {
    return { success: false, isError: true, error };
  }
}
