import { serviceTokenAllows } from './service-token';

describe('serviceTokenAllows', () => {
  it('令牌一致才放行', () => {
    expect(serviceTokenAllows('Bearer s3cret', 's3cret', true)).toBe(true);
    expect(serviceTokenAllows('bearer s3cret', 's3cret', true)).toBe(true);
    expect(serviceTokenAllows('Bearer wrong', 's3cret', true)).toBe(false);
    expect(serviceTokenAllows('Bearer s3cre', 's3cret', true)).toBe(false);
    expect(serviceTokenAllows('s3cret', 's3cret', true)).toBe(false);
    expect(serviceTokenAllows(undefined, 's3cret', false)).toBe(false);
  });

  it('未配置令牌：本地放行，部署环境拒绝', () => {
    expect(serviceTokenAllows(undefined, undefined, false)).toBe(true);
    expect(serviceTokenAllows(undefined, '  ', true)).toBe(false);
    expect(serviceTokenAllows('Bearer anything', undefined, true)).toBe(false);
  });
});
