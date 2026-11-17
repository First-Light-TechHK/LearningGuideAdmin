import { BadRequestException } from '@nestjs/common';
import { parseTriggers, parseVideoPoints } from './study-points';

function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof BadRequestException) {
      return error.getResponse() as {
        code: string;
        details: Record<string, unknown>;
      };
    }
    throw error;
  }
  return undefined;
}

describe('parseVideoPoints', () => {
  it('keeps what was typed, including a blank title and an empty time', () => {
    expect(
      parseVideoPoints([
        { title: '', timeSeconds: 5 },
        { title: 'No time' },
        { title: 'Empty time', timeSeconds: '' },
        { title: 'Text time', timeSeconds: '90' },
      ]),
    ).toEqual([
      { id: undefined, code: undefined, title: '', timeSeconds: 5 },
      { id: undefined, code: undefined, title: 'No time', timeSeconds: null },
      {
        id: undefined,
        code: undefined,
        title: 'Empty time',
        timeSeconds: null,
      },
      { id: undefined, code: undefined, title: 'Text time', timeSeconds: 90 },
    ]);
  });

  it('reads the id and code that identify an existing row', () => {
    const [row] = parseVideoPoints([
      { id: ' abc ', code: 'V3', title: 'x', timeSeconds: 1 },
    ]);
    expect(row).toMatchObject({ id: 'abc', code: 'V3' });
  });

  it('names the row of a time that is not a whole number', () => {
    for (const bad of ['abc', -1, 1.5, true, {}]) {
      const found = refusal(() =>
        parseVideoPoints([
          { title: 'ok', timeSeconds: 1 },
          { title: 'bad', timeSeconds: bad },
        ]),
      );
      expect(found?.code).toBe('INVALID_TIME');
      expect(found?.details).toMatchObject({ row: 2 });
    }
  });

  it('refuses rows that are not objects and titles that are not text', () => {
    expect(refusal(() => parseVideoPoints(['x']))?.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(refusal(() => parseVideoPoints([{ title: 4 }]))?.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(refusal(() => parseVideoPoints('x'))?.code).toBe('VALIDATION_ERROR');
  });

  it('reads a missing list as empty', () => {
    expect(parseVideoPoints(undefined)).toEqual([]);
  });
});

describe('parseTriggers', () => {
  it('treats null, empty and missing exhibits as not chosen', () => {
    expect(
      parseTriggers([
        { exhibitId: null, timeSeconds: 1 },
        { exhibitId: '', timeSeconds: 2 },
        { timeSeconds: 3 },
        { exhibitId: 'e1' },
      ]),
    ).toEqual([
      { exhibitId: null, timeSeconds: 1 },
      { exhibitId: null, timeSeconds: 2 },
      { exhibitId: null, timeSeconds: 3 },
      { exhibitId: 'e1', timeSeconds: null },
    ]);
  });

  it('refuses a time that is not a whole number and an exhibit that is not text', () => {
    expect(
      refusal(() => parseTriggers([{ exhibitId: null, timeSeconds: 'x' }]))
        ?.code,
    ).toBe('INVALID_TIME');
    expect(
      refusal(() => parseTriggers([{ exhibitId: 5, timeSeconds: 1 }]))?.code,
    ).toBe('VALIDATION_ERROR');
  });
});
