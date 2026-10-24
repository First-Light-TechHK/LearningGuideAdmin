import { sslConfig } from './db';

const RDS = 'postgresql://u:p@learning-guide-admin-dev.abc.ap-southeast-1.rds.amazonaws.com:5432/db';

describe('sslConfig', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('加密连接 RDS，但未挂载 CA 时不校验链', () => {
    delete process.env.PGSSL;
    expect(sslConfig(RDS)).toEqual({ rejectUnauthorized: false });
  });

  it('本机开发库默认不加密', () => {
    delete process.env.PGSSL;
    expect(sslConfig('postgresql://u:p@localhost:5432/db')).toBe(false);
  });

  it('PGSSL=false 可显式关闭', () => {
    process.env.PGSSL = 'false';
    expect(sslConfig(RDS)).toBe(false);
  });

  it('PGSSL_STRICT=true 时校验证书链', () => {
    process.env.PGSSL_STRICT = 'true';
    expect(sslConfig(RDS)).toEqual({ rejectUnauthorized: true });
  });
});
