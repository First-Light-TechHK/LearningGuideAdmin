/**
 * 统一响应格式类型定义（开发文档 §5.3）。
 */

/** 成功响应信封 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  error: null;
  message: string;
}

/** 错误响应信封（绝不包含堆栈、SQL、内部路径，见 §9 安全注意事项） */
export interface ApiErrorResponse {
  success: false;
  data: null;
  error: {
    code: string;
    message: string;
    /**
     * 抛出方显式放进异常响应体里的结构化业务数据（例如 COURSE_STALE 的 revision 与
     * updatedByName、PUBLISH_BLOCKED 的 blockers），前端据此原地说明；没有就不出现。
     * 不放任何实现细节：Prisma 与未知错误从不带 details。
     */
    details?: Record<string, unknown>;
  };
}
