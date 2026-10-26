/**
 * 课程 ID 映射表（2026-10-26 改拍）。
 *
 * 背景：后端课程主数据后续归 BackOffice 所有，KS 只需要知道「课程的 courseID」即可建立对应关系，
 * 不再在运行时向 Portal 拉取课程目录。
 *
 * 因此这里内置一份 courseID → 课程标题的映射表，作为同步的唯一数据源：
 * - `externalId` 即 courseID（沿用 `Course.externalId` 字段，保持既有数据结构不变）
 * - `title` 供建课与标题同步使用
 * - 当前没有 lesson 结构化数据，`lessons` 恒为空数组；后续 BackOffice 提供结构时再填充
 *
 * 后续接入 BackOffice 课程接口时，只需把 `CATALOGUE_COURSES` 换成远端数据，
 * 同步算法（`SyncService`）无需改动。
 */

/** 课程下的课时（结构与外部源一致；当前无数据） */
export interface CatalogueLesson {
  externalId: string;
  title: string;
}

/** 同步数据源中的一门课程 */
export interface CatalogueCourse {
  externalId: string;
  title: string;
  description?: string;
  lessons: CatalogueLesson[];
}

/** 映射表条目：只保留 courseID 与标题 */
interface RegistryCourse {
  externalId: string;
  title: string;
}

/**
 * 内置课程 ID 映射表：收录 Portal 已发布的 4 门课程 ID。
 * 新增课程时在此追加一行即可，无需改动同步逻辑。
 */
const COURSE_ID_REGISTRY: RegistryCourse[] = [
  { externalId: 'epicureanism', title: 'Epicureanism' },
  { externalId: 'stoicism', title: 'Stoicism' },
  { externalId: 'quintus-horatius-flaccus', title: 'Quintus Horatius Flaccus' },
  { externalId: 'modeling-life', title: 'Modeling life' },
];

/** 同步数据源课程列表（当前均无 lesson 结构） */
export const CATALOGUE_COURSES: CatalogueCourse[] = COURSE_ID_REGISTRY.map(
  (course) => ({ ...course, lessons: [] }),
);
