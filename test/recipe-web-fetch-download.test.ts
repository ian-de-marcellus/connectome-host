import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(webFetch: unknown, withShell = true) {
  return {
    name: 'web-fetch-download-test',
    agent: { systemPrompt: '' },
    modules: {
      ...(withShell ? {
        projectShell: {
          roots: [
            { name: 'library', path: '/tmp/library' },
            { name: 'scratch', path: '/tmp/scratch' },
          ],
        },
      } : {}),
      webFetch,
    },
  };
}

describe('web-fetch download recipe', () => {
  test('accepts download caps and references to configured project-shell roots', () => {
    const parsed = validateRecipe(recipe({
      timeoutMs: 30_000,
      maxDownloadBytes: 104_857_600,
      downloadRoots: ['library', 'scratch'],
    }));
    expect(typeof parsed.modules?.webFetch).toBe('object');
    expect((parsed.modules?.webFetch as { downloadRoots?: string[] }).downloadRoots)
      .toEqual(['library', 'scratch']);
  });

  test('rejects missing, unknown, duplicate, and malformed download-root configuration', () => {
    expect(() => validateRecipe(recipe({ downloadRoots: ['library'] }, false)))
      .toThrow(/requires modules.projectShell/);
    expect(() => validateRecipe(recipe({ downloadRoots: ['elsewhere'] })))
      .toThrow(/Unknown project-shell download root/);
    expect(() => validateRecipe(recipe({ downloadRoots: ['library', 'library'] })))
      .toThrow(/Duplicate web-fetch download root/);
    expect(() => validateRecipe(recipe({ downloadRoots: [] })))
      .toThrow(/non-empty array/);
    expect(() => validateRecipe(recipe({ maxDownloadBytes: 0 })))
      .toThrow(/maxDownloadBytes/);
  });
});
