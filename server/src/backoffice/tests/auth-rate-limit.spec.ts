import type { Request } from 'express';
import { consume } from '../lib/rateLimit';
import { requestPasswordReset } from '../modules/user-authentication/services/passwordFlows';
import { BackofficeAuthController } from '../nest/auth.controller';

jest.mock('../lib/rateLimit', () => ({ consume: jest.fn() }));
jest.mock('../modules/user-authentication/services/passwordFlows', () => ({
  requestPasswordReset: jest.fn(),
}));

describe('forgot-password email rate limit', () => {
  const controller = new BackofficeAuthController();
  const request = {
    ip: '127.0.0.1',
    headers: { origin: 'http://localhost' },
  } as Request;

  beforeEach(() => jest.resetAllMocks());

  it('waits for the email limit before sending and propagates rejection', async () => {
    let reached!: () => void;
    const emailLimitReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let settle!: (value: {
      allowed: boolean;
      retryAfterSeconds: number;
    }) => void;
    jest
      .mocked(consume)
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockImplementationOnce(() => {
        reached();
        return new Promise((resolve) => {
          settle = resolve;
        });
      });
    const result = controller.forgotPassword(request, {
      email: ' Example@example.com ',
    });
    const rejection = expect(result).rejects.toMatchObject({ status: 429 });
    await emailLimitReached;
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(consume).toHaveBeenLastCalledWith(
      'forgot-password-email:example@example.com',
      expect.any(Number),
      expect.any(Number),
    );
    settle({ allowed: false, retryAfterSeconds: 60 });
    await rejection;
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('sends once when both limits allow the request', async () => {
    jest.mocked(consume).mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(
      controller.forgotPassword(request, {
        email: 'example@example.com',
      }),
    ).resolves.toEqual({ requested: true });
    expect(requestPasswordReset).toHaveBeenCalledTimes(1);
  });
});
