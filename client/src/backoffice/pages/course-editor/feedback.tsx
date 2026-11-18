import { createContext, useContext } from 'react';

import type { ApiFailure } from '../../lib/api';

/**
 * 编辑页各区块报告失败的唯一入口：区块只说"哪个操作失败了、服务器怎么答的"，
 * 由页面按错误码写成当前语言的一句话；课程已被别人保存（COURSE_STALE）时页面显示"谁保存了"和重新载入按钮，
 * 区块里已输入的内容保持不动。
 */
export type ReportFailure = (action: string, failure: ApiFailure) => void;

const FailureContext = createContext<ReportFailure>(() => {});

export const FailureProvider = FailureContext.Provider;

export function useReportFailure(): ReportFailure {
  return useContext(FailureContext);
}
