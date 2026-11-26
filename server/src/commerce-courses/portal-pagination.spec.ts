import { PortalProjectionService } from './portal-projection.service';
import { PortalCoursesController } from './portal-courses.controller';

describe('Portal course pagination', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const versions = jest.fn().mockResolvedValue([]);
  const service = new PortalProjectionService({
    commerceCourse: { findMany }, courseVersion: { findMany: versions },
  } as never);

  beforeEach(() => jest.clearAllMocks());

  it('preserves legacy default and ordering', async () => {
    await service.listCourses();
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 50, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
  });

  it('uses ascending id and a strict keyset boundary in paged mode', async () => {
    await service.listCourses(200, { afterId: '00000000-0000-4000-8000-000000000001' });
    expect(findMany.mock.calls[0][0]).toMatchObject({
      take: 200, orderBy: { id: 'asc' },
      where: { id: { gt: '00000000-0000-4000-8000-000000000001' }, liveStatus: 'ONLINE' },
    });
  });

  it('passes pagination only when opted in', async () => {
    const projection = { listCourses: jest.fn() };
    const controller = new PortalCoursesController(projection as never, {} as never, {} as never);
    controller.list('200', '1', '00000000-0000-4000-8000-000000000001');
    expect(projection.listCourses).toHaveBeenCalledWith(200, { afterId: '00000000-0000-4000-8000-000000000001' });
    controller.list();
    expect(projection.listCourses).toHaveBeenLastCalledWith(undefined);
  });
});

describe('invalid live versions and pagination', () => {
  it('skips invalid or foreign versions without truncating a page', async () => {
    const rows = [
      { id: 'a', liveVersionId: 'missing' },
      { id: 'b', liveVersionId: 'foreign' },
      { id: 'c', liveVersionId: 'good' },
    ];
    const findMany = jest.fn().mockResolvedValueOnce(rows.slice(0, 2)).mockResolvedValueOnce(rows.slice(2));
    const versions = jest.fn().mockResolvedValueOnce([{ id: 'foreign', courseId: 'elsewhere', snapshotData: {} }]).mockResolvedValueOnce([{ id: 'good', courseId: 'c', snapshotData: {} }]);
    const service = new PortalProjectionService({ commerceCourse: { findMany }, courseVersion: { findMany: versions } } as never);
    jest.spyOn(service as never, 'toSummary' as never).mockImplementation(((row: { id: string }) => ({ id: row.id })) as never);
    expect(await service.listCourses(2, {})).toEqual([{ id: 'c' }]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe('public media with corrupt live pointer', () => {
  it('does not return media for a missing or foreign live version', async () => {
    const prisma = { commerceCourse: { findUnique: jest.fn().mockResolvedValue({ liveStatus: 'ONLINE', archivedAt: null, liveVersionId: 'v1', cover: { storageKey: 'x' } }) }, courseVersion: { findFirst: jest.fn().mockResolvedValue(null) }, courseMediaAsset: { findFirst: jest.fn().mockResolvedValue({ storageKey: 'x' }) } };
    const service = new PortalProjectionService(prisma as never);
    expect(await service.getCoverBytes('c1')).toBeNull();
    expect(await service.getMediaBytes('c1', 'a1')).toBeNull();
  });
});
