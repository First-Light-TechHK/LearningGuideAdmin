import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { accessLog } from './access-log';

/** 以最小实现模拟 Express 的 req/res，验证访问日志的字段与过滤规则。 */
function makeContext(method: string, path: string, status = 200) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: status,
    writableFinished: true,
  }) as unknown as Response;
  const req = {
    method,
    path,
    url: path,
    headers: { 'user-agent': 'jest-agent' },
  } as unknown as Request;
  return { req, res };
}

describe('accessLog（2026-10-28 复盘 A4）', () => {
  const original = process.env.ACCESS_LOG;
  let logged: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    delete process.env.ACCESS_LOG;
    const { Logger } = jest.requireActual('@nestjs/common');
    spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => {
    spy.mockRestore();
    if (original === undefined) delete process.env.ACCESS_LOG;
    else process.env.ACCESS_LOG = original;
  });

  it('记录成功请求的 method/path/status/duration，且不含查询串', () => {
    const { req, res } = makeContext('GET', '/api/user/ai-tutors');
    const next = jest.fn() as unknown as NextFunction;
    accessLog(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    (res as unknown as EventEmitter).emit('finish');

    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0]);
    expect(entry).toMatchObject({
      type: 'access',
      method: 'GET',
      path: '/api/user/ai-tutors',
      status: 200,
      outcome: 'finish',
    });
    expect(typeof entry.durationMs).toBe('number');
    expect(logged[0]).not.toContain('?');
  });

  it('跳过健康检查，避免淹没业务请求', () => {
    const { req, res } = makeContext('GET', '/api/health');
    accessLog(req, res, jest.fn() as unknown as NextFunction);
    (res as unknown as EventEmitter).emit('finish');
    expect(logged).toHaveLength(0);
  });

  it('ACCESS_LOG=0 时完全不记录', () => {
    process.env.ACCESS_LOG = '0';
    const { req, res } = makeContext('POST', '/api/ai/chat-stream');
    accessLog(req, res, jest.fn() as unknown as NextFunction);
    (res as unknown as EventEmitter).emit('finish');
    expect(logged).toHaveLength(0);
  });
});
