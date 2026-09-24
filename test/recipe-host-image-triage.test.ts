import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

const recipe = (hostImageTriage?: unknown) => ({
  name: 'host-image-triage-test',
  agent: { systemPrompt: '' },
  mcpServers: {
    discord: {
      command: 'discord-mcpl',
      ...(hostImageTriage === undefined ? {} : { hostImageTriage }),
    },
  },
});

describe('narrow host image triage recipe authority', () => {
  test('accepts a fixed model with bounded input and output ceilings', () => {
    const config = {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      maxImageBytes: 3_670_016,
      maxPromptChars: 20_000,
    };
    expect(validateRecipe(recipe(config)).mcpServers?.discord.hostImageTriage)
      .toEqual(config);
  });

  test('rejects malformed or excessive host ceilings', () => {
    expect(() => validateRecipe(recipe(true))).toThrow(/must be an object/);
    expect(() => validateRecipe(recipe({ model: '' }))).toThrow(/model/);
    expect(() => validateRecipe(recipe({ model: 'haiku', maxTokens: 0 })))
      .toThrow(/maxTokens/);
    expect(() => validateRecipe(recipe({ model: 'haiku', maxTokens: 16_385 })))
      .toThrow(/maxTokens/);
    expect(() => validateRecipe(recipe({ model: 'haiku', maxImageBytes: 10 * 1024 * 1024 + 1 })))
      .toThrow(/maxImageBytes/);
    expect(() => validateRecipe(recipe({ model: 'haiku', maxPromptChars: 100_001 })))
      .toThrow(/maxPromptChars/);
  });
});
