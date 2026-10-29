import {
  checkHelpdeskIntegrationToken,
  helpdeskIntegrationToken,
} from './helpdesk-integration-auth';

/**
 * Helpdesk addendum §E：Portal → Admin（questions / suggest / outcome）只认
 * Authorization: Bearer ADMIN_HELPDESK_TOKEN；环境变量每次现读；为空一律 503（本地也不放行）。
 * 令牌是本地测试值。
 */
const TOKEN = 'test-admin-helpdesk-token-local-only';

describe('Helpdesk integration auth', () => {
  it('is disabled when the token env is unset or blank, even with a header', () => {
    expect(checkHelpdeskIntegrationToken(`Bearer ${TOKEN}`, undefined)).toBe(
      'disabled',
    );
    expect(checkHelpdeskIntegrationToken(`Bearer ${TOKEN}`, '   ')).toBe(
      'disabled',
    );
  });

  it('rejects a missing, malformed or wrong token', () => {
    for (const header of [
      undefined,
      '',
      TOKEN,
      `Basic ${TOKEN}`,
      'Bearer ',
      'Bearer wrong-token',
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
    ]) {
      expect(checkHelpdeskIntegrationToken(header, TOKEN)).toBe('unauthorized');
    }
  });

  it('accepts the exact token (case-insensitive scheme, first header only)', () => {
    expect(checkHelpdeskIntegrationToken(`Bearer ${TOKEN}`, TOKEN)).toBe('ok');
    expect(
      checkHelpdeskIntegrationToken(`bearer  ${TOKEN} `, ` ${TOKEN} `),
    ).toBe('ok');
    expect(
      checkHelpdeskIntegrationToken([`Bearer ${TOKEN}`, 'Bearer x'], TOKEN),
    ).toBe('ok');
  });

  it('reads ADMIN_HELPDESK_TOKEN on every call', () => {
    const env: NodeJS.ProcessEnv = { ADMIN_HELPDESK_TOKEN: ' first ' };
    expect(helpdeskIntegrationToken(env)).toBe('first');
    env.ADMIN_HELPDESK_TOKEN = 'rotated';
    expect(helpdeskIntegrationToken(env)).toBe('rotated');
    delete env.ADMIN_HELPDESK_TOKEN;
    expect(helpdeskIntegrationToken(env)).toBeUndefined();
  });
});
