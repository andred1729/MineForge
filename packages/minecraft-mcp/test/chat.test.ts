import { describe, expect, it } from 'vitest';

import { splitChatMessage } from '../src/chat.js';

describe('splitChatMessage', () => {
  it('normalizes whitespace and prefers word boundaries', () => {
    expect(splitChatMessage('  one   two three  ', 7)).toEqual(['one two', 'three']);
  });

  it('splits an overlong word without looping', () => {
    expect(splitChatMessage('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });
});
