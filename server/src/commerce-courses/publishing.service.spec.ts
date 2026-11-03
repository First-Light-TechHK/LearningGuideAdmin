import { nextVersionLabel } from './publishing.service';

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
