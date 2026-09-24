import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectShellModule } from '../src/modules/project-shell-module.js';
import { validateRecipe } from '../src/recipe.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

describe('ProjectShellModule', () => {
  test('runs Homebrew Python while retaining the filesystem sandbox', async () => {
    const root = temp('project-shell-python-root-');
    const scratch = temp('project-shell-python-scratch-');
    const module = new ProjectShellModule({ roots: [{ name: 'project', path: root }], scratchPath: scratch });
    await module.start({} as never);

    const result = await module.handleToolCall({
      id: 'python', name: 'run', input: {
        root: 'project',
        command:
          "python3 -c 'import hashlib, json, pathlib; pathlib.Path(\"made.json\").write_text(json.dumps({\"digest\": hashlib.sha256(b\"ok\").hexdigest()}))'; " +
          "if python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 443), 0.5)' >/dev/null 2>&1; then exit 97; else printf ':network-denied'; fi",
      },
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain(':network-denied');
    expect(JSON.parse(readFileSync(join(root, 'made.json'), 'utf8')).digest)
      .toBe('2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df');
  });

  test('allows configured-root work and denies an unrelated sibling', async () => {
    const root = temp('project-shell-root-');
    const outside = temp('project-shell-outside-');
    const scratch = temp('project-shell-scratch-');
    writeFileSync(join(root, 'seed.txt'), 'inside');
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    const module = new ProjectShellModule({ roots: [{ name: 'project', path: root }], scratchPath: scratch });
    await module.start({} as never);

    const result = await module.handleToolCall({
      id: '1', name: 'run', input: {
        root: 'project',
        command: `printf 'made' > made.txt; cat seed.txt; if cat '${outside}/secret.txt' >/dev/null 2>&1; then exit 97; else printf ':outside-denied'; fi`,
      },
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain('inside:outside-denied');
    expect(readFileSync(join(root, 'made.txt'), 'utf8')).toBe('made');
  });

  test('executes configured read-only runtimes without granting write access to them', async () => {
    const root = temp('project-shell-root-');
    const runtime = temp('project-shell-runtime-');
    const scratch = temp('project-shell-scratch-');
    const helper = join(runtime, 'helper');
    writeFileSync(helper, '#!/bin/sh\nprintf runtime-ok');
    chmodSync(helper, 0o755);
    const module = new ProjectShellModule({
      roots: [{ name: 'project', path: root }],
      scratchPath: scratch,
      readOnlyPaths: [runtime],
    });
    await module.start({} as never);

    const result = await module.handleToolCall({
      id: 'read-only-runtime', name: 'run', input: {
        root: 'project',
        command:
          `'${helper}'; ` +
          `if printf no > '${join(runtime, 'blocked.txt')}' 2>/dev/null; then exit 97; else printf ':write-denied'; fi`,
      },
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain('runtime-ok:write-denied');
  });

  test('offers an explicit no-timeout mode only when the residence permits it', async () => {
    const root = temp('project-shell-long-root-');
    const scratch = temp('project-shell-long-scratch-');
    const module = new ProjectShellModule({
      roots: [{ name: 'project', path: root }],
      scratchPath: scratch,
      timeoutMs: 20,
      allowNoTimeout: true,
    });
    await module.start({} as never);

    const ordinary = await module.handleToolCall({
      id: 'ordinary-timeout',
      name: 'run',
      input: { root: 'project', command: 'sleep 0.08; printf late' },
    });
    expect(ordinary.success).toBe(false);
    expect(ordinary.error).toContain('20 ms');

    const unlimited = await module.handleToolCall({
      id: 'no-timeout',
      name: 'run',
      input: { root: 'project', timeout_mode: 'none', command: 'sleep 0.08; printf finished' },
    });
    expect(unlimited.success).toBe(true);
    expect(JSON.stringify(unlimited.data)).toContain('finished');
    expect(JSON.stringify((await module.handleToolCall({
      id: 'roots', name: 'roots', input: {},
    })).data)).toContain('noTimeoutAvailable');
  });

  test('rejects no-timeout mode when it is not enabled', async () => {
    const root = temp('project-shell-no-long-root-');
    const scratch = temp('project-shell-no-long-scratch-');
    const module = new ProjectShellModule({
      roots: [{ name: 'project', path: root }],
      scratchPath: scratch,
    });
    await module.start({} as never);
    const result = await module.handleToolCall({
      id: 'forbidden-no-timeout',
      name: 'run',
      input: { root: 'project', timeout_mode: 'none', command: 'printf never' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not permit');
  });

  test('rejects cwd escapes, including an in-root symlink to the outside', async () => {
    const root = temp('project-shell-root-');
    const outside = temp('project-shell-outside-');
    const scratch = temp('project-shell-scratch-');
    symlinkSync(outside, join(root, 'escape'));
    const module = new ProjectShellModule({ roots: [{ name: 'project', path: root }], scratchPath: scratch });
    await module.start({} as never);
    const result = await module.handleToolCall({ id: '2', name: 'run', input: { root: 'project', cwd: 'escape', command: 'pwd' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes');
  });

  test('allows a shared root while denying an explicitly excluded private subtree', async () => {
    const root = temp('project-shell-root-');
    const scratch = temp('project-shell-scratch-');
    mkdirSync(join(root, 'lectern'), { recursive: true });
    mkdirSync(join(root, 'workspace', 'diary'), { recursive: true });
    writeFileSync(join(root, 'lectern', 'day-4.md'), 'public reading');
    writeFileSync(join(root, 'workspace', 'diary', 'private.md'), 'private reflection');

    const module = new ProjectShellModule({
      roots: [{ name: 'hermitage', path: root, exclude: ['workspace/diary'] }],
      scratchPath: scratch,
    });
    await module.start({} as never);

    const result = await module.handleToolCall({
      id: '3', name: 'run', input: {
        root: 'hermitage',
        command:
          "cat lectern/day-4.md; printf 'restocked' > lectern/day-5.md; " +
          "if cat workspace/diary/private.md >/dev/null 2>&1; then exit 97; else printf ':diary-denied'; fi; " +
          "if printf 'no' > workspace/diary/attempt.md 2>/dev/null; then exit 98; else printf ':diary-write-denied'; fi",
      },
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain('public reading:diary-denied:diary-write-denied');
    expect(readFileSync(join(root, 'lectern', 'day-5.md'), 'utf8')).toBe('restocked');

    const excludedCwd = await module.handleToolCall({
      id: '4', name: 'run', input: { root: 'hermitage', cwd: 'workspace/diary', command: 'pwd' },
    });
    expect(excludedCwd.success).toBe(false);
    expect(excludedCwd.error).toContain('excluded private subtree');
  });
});

describe('project-shell recipe deadline policy', () => {
  const recipe = (allowNoTimeout: unknown) => ({
    name: 'project-shell-deadline-test',
    agent: { systemPrompt: '' },
    modules: {
      projectShell: {
        roots: [{ name: 'project', path: '/tmp/project' }],
        timeoutMs: 21_600_000,
        allowNoTimeout,
      },
    },
  });

  test('accepts an explicit no-timeout capability flag', () => {
    expect(validateRecipe(recipe(true)).modules?.projectShell?.allowNoTimeout).toBe(true);
  });

  test('rejects a non-boolean no-timeout capability flag', () => {
    expect(() => validateRecipe(recipe('yes'))).toThrow(/allowNoTimeout must be a boolean/);
  });

  test('accepts absolute read-only runtime paths and rejects relative ones', () => {
    const withPaths = recipe(true);
    withPaths.modules.projectShell.readOnlyPaths = ['/Applications/calibre.app'];
    expect(validateRecipe(withPaths).modules?.projectShell?.readOnlyPaths)
      .toEqual(['/Applications/calibre.app']);

    withPaths.modules.projectShell.readOnlyPaths = ['calibre.app'];
    expect(() => validateRecipe(withPaths)).toThrow(/entries must be absolute paths/);
  });
});
