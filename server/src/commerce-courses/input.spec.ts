import { BadRequestException } from '@nestjs/common';

import {
  oneOf,
  optionalNonNegativeInt,
  optionalString,
  requireArray,
  requireId,
} from './input';

function failure(fn: () => unknown): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as never;
  }
  throw new Error('expected the guard to throw');
}

describe('input guards', () => {
  describe('requireArray', () => {
    it('returns the array it was given', () => {
      expect(requireArray([1, 2], 'rows')).toEqual([1, 2]);
    });

    it('treats a missing value as an empty list only when asked to', () => {
      expect(requireArray(undefined, 'rows', { emptyIfMissing: true })).toEqual(
        [],
      );
      const body = failure(() => requireArray(undefined, 'rows'));
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details.field).toBe('rows');
    });

    it('refuses an object, a string and a number with the field name', () => {
      for (const bad of [{}, 'x', 3, null]) {
        expect(failure(() => requireArray(bad, 'questions')).details).toEqual({
          field: 'questions',
        });
      }
    });
  });

  describe('optionalString', () => {
    it('passes undefined and null through as undefined', () => {
      expect(optionalString(undefined, 'title')).toBeUndefined();
      expect(optionalString(null, 'title')).toBeUndefined();
    });

    it('keeps an empty string: an empty value is saved, not refused', () => {
      expect(optionalString('', 'title')).toBe('');
    });

    it('refuses a number or an object', () => {
      expect(failure(() => optionalString(12, 'title')).details.field).toBe(
        'title',
      );
      expect(failure(() => optionalString({}, 'title')).code).toBe(
        'VALIDATION_ERROR',
      );
    });

    it('refuses a string that is longer than the limit', () => {
      expect(
        failure(() => optionalString('abcd', 'title', { max: 3 })).details
          .field,
      ).toBe('title');
    });
  });

  describe('optionalNonNegativeInt', () => {
    it('returns null for null, undefined and an empty string', () => {
      expect(optionalNonNegativeInt(null, 'time')).toBeNull();
      expect(optionalNonNegativeInt(undefined, 'time')).toBeNull();
      expect(optionalNonNegativeInt('', 'time')).toBeNull();
    });

    it('accepts zero and whole numbers, also as a numeric string', () => {
      expect(optionalNonNegativeInt(0, 'time')).toBe(0);
      expect(optionalNonNegativeInt(587, 'time')).toBe(587);
      expect(optionalNonNegativeInt('90', 'time')).toBe(90);
    });

    it('refuses a negative, a fraction, NaN and text', () => {
      for (const bad of [-1, 1.5, Number.NaN, 'abc', '1.5', {}, Infinity]) {
        expect(failure(() => optionalNonNegativeInt(bad, 'time')).code).toBe(
          'VALIDATION_ERROR',
        );
      }
    });

    it('lets the caller choose the error code and add details', () => {
      const body = failure(() =>
        optionalNonNegativeInt('abc', 'timeSeconds', {
          code: 'INVALID_TIME',
          details: { row: 3 },
        }),
      );
      expect(body.code).toBe('INVALID_TIME');
      expect(body.details).toEqual({ field: 'timeSeconds', row: 3 });
    });
  });

  describe('requireId', () => {
    it('returns a trimmed non-empty string', () => {
      expect(requireId(' abc-1 ', 'lessonId')).toBe('abc-1');
    });

    it('refuses empty, missing and non-string values', () => {
      for (const bad of ['', '   ', undefined, null, 4, {}]) {
        expect(failure(() => requireId(bad, 'lessonId')).details.field).toBe(
          'lessonId',
        );
      }
    });
  });

  describe('oneOf', () => {
    it('returns an allowed value', () => {
      expect(oneOf('BOOK', ['BOOK', 'ARTICLE'] as const, 'type')).toBe('BOOK');
    });

    it('refuses anything else and names the allowed values', () => {
      const body = failure(() =>
        oneOf('MOVIE', ['BOOK', 'ARTICLE'] as const, 'type'),
      );
      expect(body.details).toEqual({
        field: 'type',
        allowed: ['BOOK', 'ARTICLE'],
      });
    });
  });
});
