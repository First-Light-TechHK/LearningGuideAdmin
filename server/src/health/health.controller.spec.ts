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
    });
  });
});
