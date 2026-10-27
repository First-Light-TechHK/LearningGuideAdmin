import {
  ArgumentsHost,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter（§5.3 统一错误格式、§9 不泄露内部细节）', () => {
  const filter = new AllExceptionsFilter();
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    // 屏蔽测试中的错误/警告日志输出
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
      }),
    } as unknown as ArgumentsHost;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function getBody(): Record<string, unknown> {
    return mockResponse.json.mock.calls[0][0] as Record<string, unknown>;
  }

  it('BadRequestException 应映射为 400 + VALIDATION_ERROR', () => {
    filter.catch(new BadRequestException('参数校验失败'), mockHost);
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(getBody()).toEqual({
      success: false,
      data: null,
      error: { code: 'VALIDATION_ERROR', message: '参数校验失败' },
    });
  });

  it('class-validator 数组消息应合并为单条字符串', () => {
    filter.catch(
      new BadRequestException({
        message: ['title 不能为空', 'sortOrder 必须是数字'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      mockHost,
    );
    const body = getBody();
    const error = body.error as { code: string; message: string };
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('title 不能为空; sortOrder 必须是数字');
  });

  it('NotFoundException 应映射为 404 + NOT_FOUND', () => {
    filter.catch(new NotFoundException(), mockHost);
    expect(mockResponse.status).toHaveBeenCalledWith(404);
    const error = getBody().error as { code: string };
    expect(error.code).toBe('NOT_FOUND');
  });

  it('4xx 客户端异常应使用 warn 级别日志，不应输出 error（会话过期/越权属正常业务）', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    filter.catch(new BadRequestException('参数校验失败'), mockHost);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[400] 参数校验失败'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('body-parser entity.too.large 应映射为 400 + VALIDATION_ERROR（不再误报 500）', () => {
    // Express body-parser 超限错误：普通 Error + type/status，不是 HttpException
    const payloadError = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    });
    filter.catch(payloadError, mockHost);
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(getBody()).toEqual({
      success: false,
      data: null,
      error: {
        code: 'VALIDATION_ERROR',
        message: '请求内容过大，请拆分文档后重试',
      },
    });
  });

  it('Prisma P2002 应映射为 409 + CONFLICT 且不泄露 meta', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      { code: 'P2002', meta: { target: ['email'] }, clientVersion: '6.19.3' },
    );
    filter.catch(prismaError, mockHost);
    expect(mockResponse.status).toHaveBeenCalledWith(409);
    const bodyStr = JSON.stringify(getBody());
    expect(bodyStr).toContain('CONFLICT');
    expect(bodyStr).not.toContain('Unique constraint');
    expect(bodyStr).not.toContain('email');
  });

  it('Prisma P2025 应映射为 404 + NOT_FOUND', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Record not found',
      { code: 'P2025', clientVersion: '6.19.3' },
    );
    filter.catch(prismaError, mockHost);
    expect(mockResponse.status).toHaveBeenCalledWith(404);
    const error = getBody().error as { code: string };
    expect(error.code).toBe('NOT_FOUND');
  });

  it('未知异常应返回 500 + INTERNAL_ERROR，响应体不含堆栈/SQL/内部路径', () => {
    const secret = new Error(
      'connect ECONNREFUSED postgresql://admin:密码@127.0.0.1:5432 at C:\\internal\\path\\service.ts',
    );
    filter.catch(secret, mockHost);
    expect(mockResponse.status).toHaveBeenCalledWith(500);
    const body = getBody();
    expect(body).toEqual({
      success: false,
      data: null,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
    });
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('stack');
    expect(bodyStr).not.toContain('ECONNREFUSED');
    expect(bodyStr).not.toContain('admin');
    expect(bodyStr).not.toContain('internal');
    // 原始错误仍写入服务器日志
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
