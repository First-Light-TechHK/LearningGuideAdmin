import { etagFor, parseIfMatch } from './draft-revision';

describe('draft revision ETag', () => {
  it('formats a strong ETag', () => {
    expect(etagFor(7)).toBe('"r7"');
  });

  it('reads strong and weak forms of our own ETag', () => {
    expect(parseIfMatch('"r7"')).toBe(7);
    expect(parseIfMatch(' W/"r12" ')).toBe(12);
    expect(parseIfMatch(['"r3"', '"r4"'])).toBe(3);
  });

  it('skips the check for a missing, wildcard or foreign ETag', () => {
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('*')).toBeNull();
    expect(parseIfMatch('W/"9c-xTJ3PwqgRCBWIVKoeuJDzzvkMpg"')).toBeNull();
  });
});
