/** Project shell network modes, against the real sandbox-exec profile. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectShellModule } from '../src/modules/project-shell-module.js';
import { validateRecipe } from '../src/recipe.js';

let local: ReturnType<typeof Bun.serve>;
const dirs: string[] = [];
beforeAll(() => { local = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('local-ok') }); });
afterAll(() => { local.stop(true); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const online = (() => {
  try { return execSync('curl -s -m 8 -o /dev/null -w "%{http_code}" https://api.github.com/zen').toString() === '200'; } catch { return false; }
})();

async function probe(network?: 'none' | 'loopback' | 'full') {
  const root = mkdtempSync(join(tmpdir(), 'ps-net-root-')); const scratch = mkdtempSync(join(tmpdir(), 'ps-net-scratch-'));
  dirs.push(root, scratch);
  const m = new ProjectShellModule({ roots: [{ name: 'p', path: root }], scratchPath: scratch, ...(network ? { network } : {}) });
  await m.start({} as never);
  const run = async (cmd: string) => JSON.stringify((await m.handleToolCall({ id: 'x', name: 'run', input: { root: 'p', command: cmd } })).data);
  return {
    local: (await run(`curl -s -m 5 http://127.0.0.1:${local.port}/ || printf local-denied`)).includes('local-ok'),
    external: (await run(`curl -s -m 8 -o /dev/null -w "%{http_code}" https://api.github.com/zen || printf external-denied`)).includes('200'),
    description: (m.getTools()[0] as { description: string }).description,
  };
}

describe('project shell network modes', () => {
  test('default (none): no localhost, no internet; described as no network', async () => {
    const r = await probe();
    expect(r.local).toBe(false);
    expect(r.external).toBe(false);
    expect(r.description).toContain('have no network access');
  });

  test('loopback: this machine only', async () => {
    const r = await probe('loopback');
    expect(r.local).toBe(true);
    expect(r.external).toBe(false);
    expect(r.description).toContain('this machine only');
  });

  test.skipIf(!online)('full: localhost and the internet (DNS + TLS) from inside the filesystem sandbox', async () => {
    const r = await probe('full');
    expect(r.local).toBe(true);
    expect(r.external).toBe(true);
    expect(r.description).toContain('have network access');
  });
});

test('recipe: network accepts the three modes and rejects anything else', () => {
  const base = (network: unknown) => ({ name: 'x', agent: { name: 'A', model: 'm', systemPrompt: 's' },
    modules: { projectShell: { roots: [{ name: 'p', path: '/tmp/p' }], network } } });
  for (const n of ['none', 'loopback', 'full']) expect(() => validateRecipe(base(n))).not.toThrow();
  expect(() => validateRecipe(base('everything'))).toThrow(/must be 'none', 'loopback' or 'full'/);
});
