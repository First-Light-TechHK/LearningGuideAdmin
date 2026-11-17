import {
  exhibitInUseMessage,
  textUsages,
  videoUsages,
  type ExhibitUsage,
} from './exhibit-usage';

const trigger = (
  exhibitId: string | null,
  timeSeconds: number | null,
  sortOrder = 0,
  language = 'en-GB',
) => ({ exhibitId, language, timeSeconds, sortOrder });

describe('videoUsages', () => {
  it('names the trigger row by its place when the rows are sorted by time', () => {
    const rows = [trigger('b', 30), trigger('a', 10), trigger('b', 50, 2)];
    expect(videoUsages(2, rows, 'a')).toEqual([
      { kind: 'VIDEO', language: 'en-GB', position: '2.1' },
    ]);
    expect(videoUsages(2, rows, 'b')).toEqual([
      { kind: 'VIDEO', language: 'en-GB', position: '2.2' },
      { kind: 'VIDEO', language: 'en-GB', position: '2.3' },
    ]);
  });

  it('puts rows without a time last and breaks ties by the saved order', () => {
    const rows = [
      trigger('x', null, 0),
      trigger('y', 5, 2),
      trigger('x', 5, 1),
    ];
    expect(videoUsages(1, rows, 'x').map((usage) => usage.position)).toEqual([
      '1.1',
      '1.3',
    ]);
  });

  it('counts the rows of each language on their own', () => {
    const rows = [
      trigger('a', 10, 0, 'en-GB'),
      trigger('b', 5, 0, 'zh-CN'),
      trigger('a', 20, 1, 'zh-CN'),
    ];
    expect(videoUsages(3, rows, 'a')).toEqual([
      { kind: 'VIDEO', language: 'en-GB', position: '3.1' },
      { kind: 'VIDEO', language: 'zh-CN', position: '3.2' },
    ]);
  });

  it('finds nothing when no row uses the exhibit', () => {
    expect(videoUsages(1, [trigger('b', 1), trigger(null, 2)], 'a')).toEqual(
      [],
    );
  });
});

describe('textUsages', () => {
  const exhibit = { id: 'id-1', code: 'E001' };
  const card =
    '<figure data-exhibit-code="E001" data-exhibit-id="id-1"></figure>';

  it('says Text <lesson>.<learning point> for a card under a Heading 1', () => {
    const html = `<h1>A</h1><h1>B</h1><h1>C</h1>${card}`;
    expect(
      textUsages(2, [{ language: 'en-GB', textHtml: html }], exhibit),
    ).toEqual([{ kind: 'TEXT', language: 'en-GB', position: '2.3' }]);
  });

  it('says only the lesson for a card before the first Heading 1', () => {
    expect(
      textUsages(
        2,
        [{ language: 'en-GB', textHtml: `${card}<h1>A</h1>` }],
        exhibit,
      ),
    ).toEqual([{ kind: 'TEXT', language: 'en-GB', position: '2' }]);
  });

  it('lists a place once even when the card is there twice', () => {
    const html = `<h1>A</h1>${card}${card}<h1>B</h1>${card}`;
    expect(
      textUsages(1, [{ language: 'en-GB', textHtml: html }], exhibit).map(
        (usage) => usage.position,
      ),
    ).toEqual(['1.1', '1.2']);
  });

  it('skips languages without text', () => {
    expect(
      textUsages(1, [{ language: 'zh-CN', textHtml: null }], exhibit),
    ).toEqual([]);
  });
});

describe('exhibitInUseMessage', () => {
  const video = (position: string, language = 'en-GB'): ExhibitUsage => ({
    kind: 'VIDEO',
    language,
    position,
  });
  const text = (position: string, language = 'en-GB'): ExhibitUsage => ({
    kind: 'TEXT',
    language,
    position,
  });

  it('names the video place', () => {
    expect(exhibitInUseMessage([video('2.1')])).toBe(
      'Used in Video 2.1. Remove it there first.',
    );
  });

  it('names the text place', () => {
    expect(exhibitInUseMessage([text('2.3')])).toBe(
      'Used in Text 2.3. Remove it there first.',
    );
    expect(exhibitInUseMessage([text('2')])).toBe(
      'Used in Text 2. Remove it there first.',
    );
  });

  it('lists the video places before the text places', () => {
    expect(exhibitInUseMessage([text('2.3'), video('2.1')])).toBe(
      'Used in Video 2.1, Text 2.3. Remove it there first.',
    );
  });

  it('adds the language only when the places are in more than one', () => {
    expect(exhibitInUseMessage([video('2.1'), video('2.1', 'zh-CN')])).toBe(
      'Used in Video 2.1 (en-GB), Video 2.1 (zh-CN). Remove it there first.',
    );
  });

  it('does not repeat a place and shortens a long list', () => {
    expect(exhibitInUseMessage([video('1.1'), video('1.1')])).toBe(
      'Used in Video 1.1. Remove it there first.',
    );
    const many = Array.from({ length: 8 }, (_, i) => video(`1.${i + 1}`));
    expect(exhibitInUseMessage(many)).toBe(
      'Used in Video 1.1, Video 1.2, Video 1.3, Video 1.4, Video 1.5 and 3 more. Remove it there first.',
    );
  });
});
