import { ServiceUnavailableException } from '@nestjs/common';

/**
 * KS Engine 对 Agent Engine 的契约（v1）。
 *
 * Agent 只能通过这个接口读写 KS 的数据，不能直接查 KS 的表。
 * 同进程时由 KS 的 Prisma 实现注入；拆成独立服务后换成 HTTP 实现（/api/ks/v1/**），
 * Agent 代码不用改。字段只做加法：新增字段可选，调用方忽略不认识的字段。
 */

/** 课程在 Tutor 侧需要的字段 */
export interface KnowledgeCourse {
  id: string;
  title: string;
  /** Portal course.slug；为空表示还没和 Portal 课程对应上 */
  externalId: string | null;
  /** 学员侧读取的上线版本 */
  currentReleaseId: string | null;
  /** 后台测试对话读取的版本；null 时回退 currentReleaseId */
  aiTestReleaseId: string | null;
  aiTutorOnline: boolean;
}

/** Release 元数据（不含正文） */
export interface KnowledgeReleaseMeta {
  id: string;
  courseId: string;
  versionTag: string;
}

/** Release 快照中的一页 */
export interface KnowledgeReleasePage {
  title: string;
  contentMd?: string;
  sectionTags?: Record<string, string[]>;
}

export interface KnowledgeRelease extends KnowledgeReleaseMeta {
  pages: KnowledgeReleasePage[];
}

export interface KnowledgeClient {
  getCourse(courseId: string): Promise<KnowledgeCourse | null>;
  getCourseByExternalId(externalId: string): Promise<KnowledgeCourse | null>;
  /** 按标题升序；mappedOnly 只返回已对应 Portal 课程的 */
  listCourses(options?: { mappedOnly?: boolean }): Promise<KnowledgeCourse[]>;
  getReleaseMeta(releaseId: string): Promise<KnowledgeReleaseMeta | null>;
  getRelease(releaseId: string): Promise<KnowledgeRelease | null>;
  /**
   * 以下两项是 Tutor 的设置，暂存在 KS 的 Course 表上；
   * 拆库时迁到 Agent 自己的库（见 docs/Engine_Split_Implementation.md）。
   */
  setTestRelease(courseId: string, releaseId: string): Promise<KnowledgeCourse>;
  setTutorOnline(courseId: string, online: boolean): Promise<KnowledgeCourse>;
}

/** Nest 注入令牌 */
export const KNOWLEDGE_CLIENT = Symbol('KNOWLEDGE_CLIENT');

/** KS 不可达或返回异常时抛出（503 KS_UNAVAILABLE）；Agent 据此降级，不当成课程不存在 */
export class KnowledgeUnavailableError extends ServiceUnavailableException {
  constructor(detail: string) {
    super({
      code: 'KS_UNAVAILABLE',
      message: `知识库服务暂不可用（${detail}）`,
    });
  }
}
