import { Injectable } from '@nestjs/common';
import { CATALOGUE_COURSES, type CatalogueCourse } from './course-registry';

/**
 * 课程目录数据源（2026-10-26 改拍）。
 *
 * 由「运行时向 Portal 拉取 `/api/integration/catalogue`」改为「读取 KS 内置课程 ID 映射表」：
 * - 不再依赖 `PORTAL_API_BASE_URL` / `PORTAL_API_TOKEN`，也不会因 Portal 不可达而同步失败
 * - 课程主数据后续归 BackOffice，KS 只按 courseID 建立对应关系
 * - `SyncService` 的同步算法保持不变，只是数据源换成本地映射表
 */
@Injectable()
export class CatalogueSourceService {
  /** 映射表中的全部课程（含同步状态计算所需的基础信息） */
  listCourses(): Promise<CatalogueCourse[]> {
    return Promise.resolve(CATALOGUE_COURSES.map((course) => ({ ...course })));
  }

  /** 按 courseID 取单门课程；不存在说明该课程不在映射表中（本地独有课程） */
  getCourse(externalId: string): Promise<CatalogueCourse | null> {
    const found = CATALOGUE_COURSES.find(
      (course) => course.externalId === externalId,
    );
    return Promise.resolve(found ? { ...found } : null);
  }
}
