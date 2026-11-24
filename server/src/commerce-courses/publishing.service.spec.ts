import { BadRequestException, ConflictException } from '@nestjs/common';
import { nextVersionLabel, parseChangeStatusBody } from './publishing.service';

describe('nextVersionLabel', () => {
  it('starts Sandbox at 1.1', () => {
    expect(nextVersionLabel('sandbox', null)).toEqual({
      label: '1.1',
      series: 1,
      minor: 1,
    });
  });

  it('increments Sandbox minor version', () => {
    expect(
      nextVersionLabel('sandbox', {
        versionSeries: 1,
        versionMinor: 1,
        exportedAt: null,
      }),
    ).toEqual({ label: '1.2', series: 1, minor: 2 });
  });

  it('starts a new Sandbox series after export', () => {
    expect(
      nextVersionLabel('sandbox', {
        versionSeries: 1,
        versionMinor: 4,
        exportedAt: new Date('2026-10-30T00:00:00Z'),
      }),
    ).toEqual({ label: '2.1', series: 2, minor: 1 });
  });

  it('uses integer versions in Production', () => {
    expect(nextVersionLabel('production', null)).toEqual({
      label: 'Version 1',
      series: 0,
      minor: 1,
    });
    expect(
      nextVersionLabel('production', {
        versionSeries: 0,
        versionMinor: 3,
        exportedAt: null,
      }),
    ).toEqual({ label: 'Version 4', series: 0, minor: 4 });
  });
});

describe('parseChangeStatusBody', () => {
  function failure(run: () => unknown): {
    status: number;
    code: string;
    details?: Record<string, unknown>;
  } {
    try {
      run();
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        const body = error.getResponse() as {
          code: string;
          details?: Record<string, unknown>;
        };
        return {
          status: error.getStatus(),
          code: body.code,
          details: body.details,
        };
      }
      throw error;
    }
    throw new Error('expected the parser to refuse the body');
  }

  it('returns the validated status and a trimmed reason', () => {
    expect(
      parseChangeStatusBody({ status: 'ONLINE', reason: '  Go online  ' }),
    ).toEqual({ status: 'ONLINE', reason: 'Go online' });
    expect(parseChangeStatusBody({ status: 'HIDDEN', reason: 'Hide' })).toEqual(
      { status: 'HIDDEN', reason: 'Hide' },
    );
    expect(
      parseChangeStatusBody({ status: 'OFFLINE', reason: 'Take down' }),
    ).toEqual({ status: 'OFFLINE', reason: 'Take down' });
  });

  it('turns a missing or invalid status into 400 VALIDATION_ERROR', () => {
    for (const body of [
      {},
      { reason: 'no status' },
      { status: 'LIVE', reason: 'bad status' },
      { status: 1, reason: 'bad type' },
      undefined,
      null,
      [],
      'ONLINE',
    ]) {
      const refused = failure(() => parseChangeStatusBody(body));
      expect(refused.status).toBe(400);
      expect(refused.code).toBe('VALIDATION_ERROR');
      expect(refused.details?.field).toBe('status');
      expect(refused.details?.allowed).toEqual(['ONLINE', 'HIDDEN', 'OFFLINE']);
    }
  });

  it('keeps 409 REASON_REQUIRED for a missing, blank or non-text reason', () => {
    for (const body of [
      { status: 'ONLINE' },
      { status: 'ONLINE', reason: '' },
      { status: 'ONLINE', reason: '   ' },
      { status: 'ONLINE', reason: null },
      { status: 'ONLINE', reason: 42 },
    ]) {
      const refused = failure(() => parseChangeStatusBody(body));
      expect(refused.status).toBe(409);
      expect(refused.code).toBe('REASON_REQUIRED');
    }
  });
});
