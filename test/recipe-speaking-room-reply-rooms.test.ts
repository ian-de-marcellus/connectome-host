import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

const recipe = (speakingRoom: unknown) => ({ name: 'reply-rooms', agent: { systemPrompt: 'sys', speakingRoom } });

describe('agent.speakingRoom.replyRooms', () => {
  test('accepts a list of channel ids and keeps it', () => {
    const r = validateRecipe(recipe({ initialChannel: 'discord:g:math', replyRooms: ['discord:g:library'] }));
    expect(r.agent.speakingRoom?.replyRooms).toEqual(['discord:g:library']);
  });
  test('rejects malformed values at load', () => {
    for (const bad of ['discord:g:library', [''], [3], {}]) {
      expect(() => validateRecipe(recipe({ initialChannel: 'discord:g:math', replyRooms: bad }))).toThrow(/replyRooms/);
    }
  });
});
