import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(subagents: unknown) {
  return {
    name: 'subagent-model-policy-test',
    agent: { systemPrompt: '' },
    modules: { subagents },
  };
}

describe('subagent model recipe policy', () => {
  test('accepts an explicit model allowlist, default, and output ceiling', () => {
    const subagents = {
      defaultModel: 'claude-sonnet-5',
      allowedModels: [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-5',
        'claude-opus-5',
      ],
      defaultMaxTokens: 8_192,
    };
    expect(validateRecipe(recipe(subagents)).modules?.subagents).toEqual(subagents);
  });

  test('rejects malformed or internally inconsistent model policies', () => {
    expect(() => validateRecipe(recipe(null))).toThrow(/boolean or object/);
    expect(() => validateRecipe(recipe({ defaultModel: '' }))).toThrow(/defaultModel/);
    expect(() => validateRecipe(recipe({ defaultMaxTokens: 0 }))).toThrow(/defaultMaxTokens/);
    expect(() => validateRecipe(recipe({
      defaultModel: 'sonnet',
      allowedModels: [],
    }))).toThrow(/non-empty array/);
    expect(() => validateRecipe(recipe({
      defaultModel: 'sonnet',
      allowedModels: ['sonnet', 'sonnet'],
    }))).toThrow(/duplicates/);
    expect(() => validateRecipe(recipe({
      allowedModels: ['sonnet'],
    }))).toThrow(/requires an explicit defaultModel/);
    expect(() => validateRecipe(recipe({
      defaultModel: 'opus',
      allowedModels: ['sonnet'],
    }))).toThrow(/must be included/);
  });
});
