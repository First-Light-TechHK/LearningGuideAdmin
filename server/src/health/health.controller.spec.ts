import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'APP_ENV' ? 'DEV' : undefined),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('reports the service and its environment', () => {
    expect(controller.check()).toEqual({
      status: 'ok',
      service: 'learning-guide-admin',
      environment: 'DEV',
      buildCommit: null,
    });
  });
});


describe('build identity', () => {
  it('reads only a valid immutable artifact, ignoring runtime APP_VERSION', async () => {
    const { readBuildCommit } = await import('./build-identity');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-build-identity-'));
    const file = path.join(dir, 'build-info.json');
    try {
      process.env.APP_VERSION = 'b'.repeat(40);
      expect(readBuildCommit(file)).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ buildCommit: 'a'.repeat(40) }));
      expect(readBuildCommit(file)).toBe('a'.repeat(40));
      fs.writeFileSync(file, JSON.stringify({ buildCommit: 'not-a-sha' }));
      expect(readBuildCommit(file)).toBeNull();
    } finally { delete process.env.APP_VERSION; fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
