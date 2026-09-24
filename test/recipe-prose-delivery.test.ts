import { describe, expect, it } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (proseDelivery?: unknown) => ({
  name: 'test',
  agent: {
    systemPrompt: '',
    ...(proseDelivery === undefined ? {} : { proseDelivery }),
  },
});

describe('prose delivery recipe', () => {
  it('accepts live, terminal, and omission', () => {
    expect(validateRecipe(base()).agent.proseDelivery).toBeUndefined();
    for (const mode of ['live', 'terminal'] as const) {
      const recipe = validateRecipe(base(mode));
      expect(recipe.agent.proseDelivery).toBe(mode);
      expect(buildFrameworkAgentConfig(recipe, 'agent', 'model', undefined).proseDelivery).toBe(mode);
    }
  });

  it('rejects unknown modes', () => {
    expect(() => validateRecipe(base('eventually-ish'))).toThrow(/proseDelivery/);
  });
});
