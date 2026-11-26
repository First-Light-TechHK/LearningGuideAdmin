import { buildCoursePackage } from './exporter';

describe('buildCoursePackage — 草稿导出不携带软删除课时', () => {
  it('queries only lessons with archivedAt=null (PRD §22)', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const prisma = { commerceCourse: { findUnique } };
    await expect(
      buildCoursePackage(prisma as never, {} as never, 'c1', 'working'),
    ).rejects.toThrow('Course not found');
    const args = findUnique.mock.calls[0] as unknown as [
      { include: { lessons: { where: unknown; orderBy: unknown } } },
    ];
    const include = args[0].include;
    expect(include.lessons.where).toEqual({ archivedAt: null });
    expect(include.lessons.orderBy).toEqual({ sortOrder: 'asc' });
  });
});

describe('export media diagnostics', () => {
  it.each([
    [{ code: 'ENOENT' }, /media object is missing/i],
    [{ name: 'NoSuchKey' }, /media object is missing/i],
    [{ name: 'NoSuchBucket', message: 'sensitive-bucket' }, /storage unavailable/i],
    [{ name: 'AccessDenied', message: 'sensitive-bucket' }, /storage unavailable/i],
  ])('distinguishes missing files from unavailable storage without leaking internals', async (error, expected) => {
    const { readExportMedia } = await import('./exporter');
    const storage = { getMedia: jest.fn().mockRejectedValue(error) };
    await expect(readExportMedia(storage as never, 'secret-key', 'media/video.mp4')).rejects.toThrow(expected);
  });
});
