import { CatalogueSourceService } from './catalogue-source.service';
import { CATALOGUE_COURSES } from './course-registry';

/**
 * 课程 ID 映射表数据源单元测试（2026-10-26）。
 * 数据源已从「运行时向 Portal 拉取」改为「KS 内置映射表」，这里锁定映射表内容与查询行为。
 */
describe('CatalogueSourceService（2026-10-26）', () => {
  const service = new CatalogueSourceService();

  it('listCourses：返回内置映射表的全部课程', async () => {
    const courses = await service.listCourses();
    expect(courses.map((course) => course.externalId)).toEqual([
      'epicureanism',
      'stoicism',
      'quintus-horatius-flaccus',
      'modeling-life',
    ]);
    expect(courses.every((course) => typeof course.title === 'string')).toBe(
      true,
    );
  });

  it('listCourses：当前无 lesson 结构化数据，lessons 恒为空数组', async () => {
    const courses = await service.listCourses();
    expect(courses.every((course) => Array.isArray(course.lessons))).toBe(true);
    expect(courses.every((course) => course.lessons.length === 0)).toBe(true);
  });

  it('getCourse：按 courseID 命中并返回课程', async () => {
    const course = await service.getCourse('modeling-life');
    expect(course).toEqual({
      externalId: 'modeling-life',
      title: 'Modeling life',
      lessons: [],
    });
  });

  it('getCourse：映射表中不存在时返回 null（本地独有课程）', async () => {
    await expect(service.getCourse('ext-population-001')).resolves.toBeNull();
  });

  it('数据源为本地常量，不依赖任何环境变量或网络', () => {
    // 映射表内容稳定；此前 Portal 数据源需要 PORTAL_API_BASE_URL / PORTAL_API_TOKEN
    expect(CATALOGUE_COURSES).toHaveLength(4);
  });
});
