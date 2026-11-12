const messages: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'], running: ['运行中', 'Running'], stopping: ['停止中', 'Stopping'], stopped: ['已停止', 'Stopped'], completed: ['已结束', 'Finished'],
  pending: ['待执行', 'Pending'], success: ['成功', 'Success'], failed: ['失败', 'Failed'],
  INVALID_CONFIG: ['测试配置无效', 'Invalid test configuration'], INVALID_XLSX: ['请上传有效的xlsx文件', 'Upload a valid xlsx file'],
  FILE_TOO_LARGE: ['文件不能超过5MB', 'Maximum file size is 5 MB'], INVALID_QUESTIONS_SHEET: ['Questions工作表缺失或有合并单元格', 'Questions sheet is missing or contains merged cells'],
  TOO_MANY_ROWS_OR_COLUMNS: ['题目表行数或列数超过限制', 'Too many rows or columns'], INVALID_HEADERS: ['表头不符合模板要求', 'Headers do not match the template'],
  INVALID_KIND: ['测试类型无效', 'Invalid test type'], INVALID_MODES: ['请选择有效的对话模式', 'Select valid dialogue modes'], EMPTY_FILE: ['没有有效题目', 'No questions found'],
  TOO_MANY_ANSWERS: ['最多生成200份回答', 'Maximum 200 answers per job'], INVALID_ROW: ['数据类型无效', 'Invalid row data'], INVALID_ID: ['编号为空或超过100字符', 'ID is empty or exceeds 100 characters'],
  INVALID_QUESTION: ['问题为空或超过8000字符', 'Question is empty or exceeds 8000 characters'], INVALID_TURN: ['轮次必须为从1开始的整数', 'Turns must be integers starting at 1'],
  DUPLICATE_TURN: ['编号与轮次重复', 'Duplicate ID and turn'], TURN_GAP: ['轮次不连续', 'Turns contain gaps'], FORMULA_NOT_ALLOWED: ['不允许使用公式', 'Formulas are not allowed'],
  USER_STOPPED_INCOMPLETE: ['用户停止，回答不完整', 'Stopped by user; incomplete answer'], USER_STOPPED_NOT_EXECUTED: ['用户停止，未执行', 'Stopped by user; not executed'],
  EXECUTION_INTERRUPTED: ['执行中断', 'Execution interrupted'], PREVIOUS_TURN_FAILED: ['前一轮失败，未执行', 'Not executed because an earlier turn failed'],
  MODEL_UNAVAILABLE: ['原模型不可用，请新建测试', 'Original model unavailable; create a new test'], SESSION_EXPIRED_START_NEW_TEST: ['测试会话已过期，请开始新测试', 'Session expired; start a new test'],
  TASK_STILL_RUNNING: ['请先停止任务并等待结束', 'Stop the task and wait for it to finish first'], STOP_TASK_FIRST: ['请先停止任务', 'Stop the task first'],
};
export function evaluationText(value: string, en: boolean): string {
  return value.replace(/[A-Z][A-Z_]+|\b(?:queued|running|stopping|stopped|completed|pending|success|failed)\b/g, (code) => messages[code]?.[en ? 1 : 0] ?? code);
}
