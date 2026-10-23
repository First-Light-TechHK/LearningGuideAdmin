import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { CryptoService } from './crypto.service';

const KEY = 'a'.repeat(64);

function makeService(key: string | undefined): CryptoService {
  const config = { get: () => key } as unknown as ConfigService;
  return new CryptoService(config);
}

describe('CryptoService（§2 红线：apiKey 加密存储）', () => {
  it('加解密往返一致，密文不含明文', () => {
    const svc = makeService(KEY);
    const cipher = svc.encrypt('sk-or-secret-123');
    expect(cipher).not.toContain('sk-or-secret');
    expect(cipher.split(':')).toHaveLength(3);
    expect(svc.decrypt(cipher)).toBe('sk-or-secret-123');
  });

  it('同一明文两次加密结果不同（随机 IV）', () => {
    const svc = makeService(KEY);
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
  });

  it('密文被篡改时解密失败（GCM authTag 校验）', () => {
    const svc = makeService(KEY);
    const cipher = svc.encrypt('hello');
    const [iv, tag, data] = cipher.split(':');
    // 末字节按位取反：保证篡改后的密文一定不同（固定写成 'ff' 在原文本身
    // 以 ff 结尾时是空操作，会间歇性通过 CI）
    const flipped = (parseInt(data.slice(-2), 16) ^ 0xff)
      .toString(16)
      .padStart(2, '0');
    const tampered = `${iv}:${tag}:${data.slice(0, -2)}${flipped}`;
    expect(tampered).not.toBe(cipher);
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('密钥缺失/格式错误抛内部错误（不外泄密钥细节）', () => {
    expect(() => makeService(undefined).encrypt('x')).toThrow(
      InternalServerErrorException,
    );
    expect(() => makeService('tooshort').encrypt('x')).toThrow(
      InternalServerErrorException,
    );
  });
});
