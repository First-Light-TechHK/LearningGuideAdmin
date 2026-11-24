import type { ConfigService } from '@nestjs/config';

import { CAPABILITY_IDS } from '../common/capabilities';
import { commerceConfig, type CommerceCourseConfig } from './commerce.config';
import { EnvironmentController } from './environment.controller';

const commerce = {
  environmentLabel: 'Sandbox',
  publicSiteUrl: 'https://sandbox.example.com',
  versionNumberingMode: 'sandbox',
  stripeSecretKey: undefined,
  previewEntry: 'learner',
} as unknown as CommerceCourseConfig;

function controllerFor(raw: string | undefined): EnvironmentController {
  const config = {
    get: (key: string) => (key === 'ADMIN_CAPABILITIES' ? raw : undefined),
  } as unknown as ConfigService;
  return new EnvironmentController(commerce, config);
}

describe('GET /api/backoffice/environment 的能力集字段', () => {
  it('ADMIN_CAPABILITIES 未配置时返回全部能力（老前端忽略该字段，字段本身始终存在）', () => {
    const body = controllerFor(undefined).get();
    expect(body.capabilities).toEqual([...CAPABILITY_IDS]);
    // 既有字段不变（向后兼容）
    expect(body.label).toBe('Sandbox');
    expect(body.versionNumberingMode).toBe('sandbox');
  });

  it('配置子集时按固定顺序返回启用能力', () => {
    expect(controllerFor('course').get().capabilities).toEqual(['course']);
    expect(controllerFor('students, COURSE').get().capabilities).toEqual([
      'course',
      'students',
    ]);
  });
});

describe('GET /api/backoffice/environment 的预览入口字段（PREVIEW_ENTRY）', () => {
  function controllerWith(
    env: Record<string, string | undefined>,
  ): EnvironmentController {
    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;
    return new EnvironmentController(commerceConfig(config), config);
  }

  it('PREVIEW_ENTRY 未配置时缺省 learner（保持上游行为）', () => {
    expect(
      commerceConfig({
        get: () => undefined,
      } as unknown as ConfigService).previewEntry,
    ).toBe('learner');
    expect(controllerWith({}).get().previewEntry).toBe('learner');
  });

  it('PREVIEW_ENTRY=portal 原样透传', () => {
    expect(
      commerceConfig({
        get: (key: string) => (key === 'PREVIEW_ENTRY' ? 'portal' : undefined),
      } as unknown as ConfigService).previewEntry,
    ).toBe('portal');
    expect(controllerWith({ PREVIEW_ENTRY: 'portal' }).get().previewEntry).toBe(
      'portal',
    );
  });
});
