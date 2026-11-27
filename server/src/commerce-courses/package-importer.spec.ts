import { PackageImporter, probeVideoDurationSeconds } from './package-importer';
import type { PackageManifest } from './contracts/manifest';

/** 构造一个不含媒体的最小课程包清单（lessons 为空，便于聚焦冲突/slug 逻辑）。 */
function manifestWith(code: string, slug: string): PackageManifest {
  return {
    format: 'lg-course-package',
    formatVersion: 1,
    packageId: 'pkg_test',
    exportedAt: new Date().toISOString(),
    source: {},
    incomplete: false,
    course: {
      code,
      slug,
      category: '',
      learningMode: 'VIDEO_ONLY',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      localized: { 'en-GB': { title: 'Modeling life' } },
      lessons: [],
      trial: { enabled: false, lessons: [] },
      pricing: [],
    },
  };
}

/**
 * 极简 Prisma mock：只实现 importPackage 用到的查询与写入。
 * - code 查询永远返回 null（模拟 Course ID 未占用）；
 * - slug 查询按 occupiedSlugs 返回是否占用。
 */
function fakePrisma(occupiedSlugs: Set<string>) {
  const createdCourses: Array<{ code: string; slug: string }> = [];
  const findFirst = ({
    where,
  }: {
    where: { code?: string; slug?: string };
  }) => {
    if (where.code !== undefined) return Promise.resolve(null);
    if (where.slug !== undefined)
      return Promise.resolve(
        occupiedSlugs.has(where.slug) ? { id: 'existing' } : null,
      );
    return Promise.resolve(null);
  };
  const prisma = {
    commerceCourse: { findFirst },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        commerceCourse: {
          create: ({ data }: { data: { code: string; slug: string } }) => {
            createdCourses.push({ code: data.code, slug: data.slug });
            return Promise.resolve(data);
          },
        },
        courseAuthoringActivity: { create: () => Promise.resolve({}) },
      }),
    _createdCourses: createdCourses,
  };
  return prisma;
}

function importer(prisma: unknown): PackageImporter {
  // 无媒体、无分类时不会用到 storage/config，传占位即可
  return new PackageImporter(prisma as never, {} as never, {} as never);
}

const options = {
  onConflict: 'ABORT' as const,
  reassignCodes: false,
  actorEmployeeId: null,
};

describe('PackageImporter.importPackage — Course ID vs slug 冲突', () => {
  it('keeps the Course ID and uniquifies a collided slug instead of refusing the import', async () => {
    const prisma = fakePrisma(new Set(['modeling-life']));
    await importer(prisma).importPackage(
      manifestWith('SCI001', 'modeling-life'),
      new Map(),
      options,
    );
    expect(prisma._createdCourses).toHaveLength(1);
    // Course ID 必须保留 SCI001（不能被 slug 冲突误判为「课程已存在」）
    expect(prisma._createdCourses[0].code).toBe('SCI001');
    // slug 被占用则自动追加序号
    expect(prisma._createdCourses[0].slug).toBe('modeling-life-2');
  });

  it('keeps the original slug when it is free', async () => {
    const prisma = fakePrisma(new Set());
    await importer(prisma).importPackage(
      manifestWith('SCI001', 'modeling-life'),
      new Map(),
      options,
    );
    expect(prisma._createdCourses[0]).toMatchObject({
      code: 'SCI001',
      slug: 'modeling-life',
    });
  });

  it('refuses when the Course ID itself already exists', async () => {
    // code 查询返回既有课程 → 触发 ABORT
    const prisma = {
      commerceCourse: {
        findFirst: ({ where }: { where: { code?: string } }) =>
          Promise.resolve(
            where.code !== undefined ? { id: 'x', code: where.code } : null,
          ),
      },
      $transaction: () => Promise.resolve({}),
    };
    await expect(
      importer(prisma).importPackage(
        manifestWith('SCI001', 'modeling-life'),
        new Map(),
        options,
      ),
    ).rejects.toMatchObject({ code: 'PACKAGE_CONFLICT' });
  });
});

describe('probeVideoDurationSeconds（导入时按真实文件探测）', () => {
  /** ftyp 签名 + 可选 mvhd（version 0，timescale 1000）。 */
  function mp4(seconds: number | null): Buffer {
    const ftyp = Buffer.alloc(24);
    ftyp.writeUInt32BE(24, 0);
    ftyp.write('ftyp', 4, 'ascii');
    ftyp.write('isom', 8, 'ascii');
    if (seconds === null) return Buffer.concat([ftyp, Buffer.alloc(24)]);
    const mvhd = Buffer.alloc(28);
    mvhd.write('mvhd', 0, 'ascii');
    mvhd.writeUInt8(0, 4);
    mvhd.writeUInt32BE(1000, 4 + 12);
    mvhd.writeUInt32BE(Math.round(seconds * 1000), 4 + 16);
    return Buffer.concat([ftyp, mvhd]);
  }

  it('reads the mvhd timescale/duration for mp4 and mov', () => {
    expect(probeVideoDurationSeconds('mp4', mp4(3))).toBe(3);
    expect(probeVideoDurationSeconds('mov', mp4(692.4))).toBe(692);
  });

  it('returns null when the container has no mvhd, is empty, or is not ISO BMFF', () => {
    expect(probeVideoDurationSeconds('mp4', mp4(null))).toBeNull();
    expect(probeVideoDurationSeconds('mp4', mp4(0))).toBeNull();
    expect(probeVideoDurationSeconds('webm', mp4(3))).toBeNull();
    expect(probeVideoDurationSeconds('mp4', Buffer.alloc(0))).toBeNull();
  });
});

describe('PackageImporter — 竞态下的冲突策略错误码', () => {
  it('确认后课程 ID 才出现时，CREATE_NEW_COURSE 返回 422 STRATEGY_UNSUPPORTED', async () => {
    const prisma = {
      commerceCourse: {
        findFirst: ({ where }: { where: { code?: string } }) =>
          Promise.resolve(
            where.code ? { id: 'existing', code: where.code } : null,
          ),
      },
    };
    await expect(
      importer(prisma).importPackage(
        manifestWith('SCI001', 'modeling-life'),
        new Map(),
        {
          ...options,
          onConflict: 'CREATE_NEW_COURSE',
        },
      ),
    ).rejects.toMatchObject({
      code: 'PACKAGE_CONFLICT_STRATEGY_UNSUPPORTED',
      status: 422,
    });
  });
});

describe('sandbox live pointer recovery', () => {
  it('allows only an existing corrupt pointer and rejects healthy or unpublished courses', async () => {
    const { assertRecoverableLivePointer } = await import('./package-importer');
    const tx = { $queryRaw: jest.fn(), courseVersion: { findFirst: jest.fn() } };
    tx.$queryRaw.mockResolvedValue([{ liveVersionId: 'v1' }]);
    tx.courseVersion.findFirst.mockResolvedValue(null);
    await expect(assertRecoverableLivePointer(tx as never, 'c1')).resolves.toBeUndefined();
    tx.courseVersion.findFirst.mockResolvedValue({ id: 'v1' });
    await expect(assertRecoverableLivePointer(tx as never, 'c1')).rejects.toMatchObject({code:'RECOVERY_NOT_APPLICABLE'});
    tx.$queryRaw.mockResolvedValue([{ liveVersionId: null }]);
    await expect(assertRecoverableLivePointer(tx as never, 'c1')).rejects.toMatchObject({code:'RECOVERY_NOT_APPLICABLE'});
  });
});
