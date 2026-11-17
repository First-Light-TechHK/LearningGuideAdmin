import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import {
  DraftRevisionInterceptor,
  etagFor,
  parseIfMatch,
} from './draft-revision';

function staleContext(ifMatch: string) {
  const request = {
    method: 'PUT',
    params: { id: 'course-1' },
    headers: { 'if-match': ifMatch },
    employee: { employeeId: 'editor-2' },
  };
  const response = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('DraftRevisionInterceptor stale claim', () => {
  const next = { handle: jest.fn() } as unknown as CallHandler;

  function interceptorWith(current: {
    revision: number;
    revisionBy: string | null;
  }) {
    const prisma = {
      // The conditional UPDATE matched no row: somebody else saved first.
      $queryRaw: jest.fn().mockResolvedValue([]),
      commerceCourse: { findUnique: jest.fn().mockResolvedValue(current) },
      employee: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { employeeId: 'editor-1', loginEmail: 'anna.li@example.org' },
          ]),
      },
    };
    return new DraftRevisionInterceptor(prisma as unknown as PrismaService);
  }

  async function stale(current: {
    revision: number;
    revisionBy: string | null;
  }): Promise<ConflictException> {
    try {
      await interceptorWith(current).intercept(staleContext('"r3"'), next);
    } catch (error) {
      return error as ConflictException;
    }
    throw new Error('expected COURSE_STALE');
  }

  it('names the other operator in the PRD sentence and gives details', async () => {
    const error = await stale({ revision: 7, revisionBy: 'editor-1' });
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      code: 'COURSE_STALE',
      message:
        'This course was updated by anna.li. Reload to see the latest changes.',
      details: {
        revision: 7,
        updatedBy: 'editor-1',
        updatedByName: 'anna.li',
      },
    });
  });

  it('says someone else when nobody is recorded as the last editor', async () => {
    const error = await stale({ revision: 7, revisionBy: null });
    expect(error.getResponse()).toMatchObject({
      message:
        'This course was updated by someone else. Reload to see the latest changes.',
      details: { revision: 7, updatedBy: null, updatedByName: null },
    });
  });
});

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
