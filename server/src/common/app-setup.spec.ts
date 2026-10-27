import { INestApplication } from '@nestjs/common';
import { JSON_BODY_LIMIT, configureApp } from './app-setup';

describe('configureApp（§5.1 全局前缀 / §9.3 输入校验 / §10.1 Import 请求体上限）', () => {
  interface FakeApp {
    setGlobalPrefix: jest.Mock;
    useGlobalPipes: jest.Mock;
    useBodyParser?: jest.Mock;
  }

  function createApp(withBodyParser = true): FakeApp {
    return {
      setGlobalPrefix: jest.fn(),
      useGlobalPipes: jest.fn(),
      ...(withBodyParser ? { useBodyParser: jest.fn() } : {}),
    };
  }

  it('设置 /api 全局前缀与全局校验管道', () => {
    const app = createApp();
    configureApp(app as unknown as INestApplication);
    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api');
    expect(app.useGlobalPipes).toHaveBeenCalledTimes(1);
  });

  it('放宽 JSON 请求体上限：Import 大文档不再被默认 100KB 拒绝', () => {
    const app = createApp();
    configureApp(app as unknown as INestApplication);
    expect(JSON_BODY_LIMIT).toBe('25mb');
    expect(app.useBodyParser).toHaveBeenCalledWith('json', {
      limit: JSON_BODY_LIMIT,
    });
  });

  it('适配器不支持 useBodyParser 时不抛错', () => {
    const app = createApp(false);
    expect(() =>
      configureApp(app as unknown as INestApplication),
    ).not.toThrow();
  });
});
