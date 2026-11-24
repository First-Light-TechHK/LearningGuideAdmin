import { appEnvName, isDeclaredNonProd, isDeployed, isDevRuntime } from './env';

// env.ts 的取值全部延迟求值（每次现读 process.env），测试直接改 process.env 并在结束后恢复。
const APP_ENV = 'APP_ENV';
const NODE_ENV = 'NODE_ENV';

function withEnv(
  values: Record<string, string | undefined>,
  run: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('appEnvName', () => {
  it('recognises SANDBOX as its own environment instead of folding it to DEV', () => {
    withEnv({ [APP_ENV]: 'SANDBOX' }, () => {
      expect(appEnvName()).toBe('SANDBOX');
    });
  });

  it('normalises case for SANDBOX', () => {
    withEnv({ [APP_ENV]: 'sandbox' }, () => {
      expect(appEnvName()).toBe('SANDBOX');
    });
  });

  it.each(['SIT', 'UAT', 'PPE', 'PROD'] as const)('recognises %s', (value) => {
    withEnv({ [APP_ENV]: value }, () => {
      expect(appEnvName()).toBe(value);
    });
  });

  it('folds unknown values to DEV (historical fallback semantics)', () => {
    withEnv({ [APP_ENV]: 'STAGING' }, () => {
      expect(appEnvName()).toBe('DEV');
    });
  });

  it('defaults to DEV when APP_ENV is unset', () => {
    withEnv({ [APP_ENV]: undefined }, () => {
      expect(appEnvName()).toBe('DEV');
    });
  });
});

describe('environment predicates', () => {
  it('isDeclaredNonProd is true for an explicitly set SANDBOX', () => {
    withEnv({ [APP_ENV]: 'SANDBOX' }, () => {
      expect(isDeclaredNonProd()).toBe(true);
    });
  });

  it('isDeclaredNonProd is false when APP_ENV is unset (treated as production)', () => {
    withEnv({ [APP_ENV]: undefined }, () => {
      expect(isDeclaredNonProd()).toBe(false);
    });
  });

  it('isDeployed is true under NODE_ENV=production even for SANDBOX (App Runner runs production mode)', () => {
    withEnv({ [APP_ENV]: 'SANDBOX', [NODE_ENV]: 'production' }, () => {
      expect(isDeployed()).toBe(true);
    });
  });

  it('isDevRuntime is false for SANDBOX under NODE_ENV=production', () => {
    withEnv({ [APP_ENV]: 'SANDBOX', [NODE_ENV]: 'production' }, () => {
      expect(isDevRuntime()).toBe(false);
    });
  });

  it('isDevRuntime is true for DEV without production NODE_ENV', () => {
    withEnv({ [APP_ENV]: 'DEV', [NODE_ENV]: 'development' }, () => {
      expect(isDevRuntime()).toBe(true);
    });
  });
});
