import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { configureApp } from '../../common/app-setup';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import {
  faqReleaseEtag,
  type FaqEdge,
  type FaqNode,
  type FaqRelease,
} from '../../contracts/helpdesk-qa';
import { splitAnswerBlocks } from '../modules/helpdesk/faqs/faqBlocks';
import {
  currentRelease,
  freezeNode,
  HELPDESK_FAQ_RELEASE_SOURCE,
  noFaqReleases,
  publicRelease,
  type FaqReleaseSource,
  type PublishedFaqRelease,
} from '../modules/helpdesk/faqs/faqRelease';
import { resolveSession } from '../modules/user-authentication/services/session';
import { BackofficeAccessGuard } from '../nest/backoffice-access.guard';
import { HelpdeskIntegrationFaqReleaseController } from '../nest/helpdesk-faq-release.controller';

/**
 * v5 问题树的发布快照（helpdesk-v5-faq-graph-design §2.2 / §4，契约 fixture v6）：
 * 快照（双语）→ Portal 读的一种语言；答案块由代码在发布时切好；ETag "v<version>"、If-None-Match → 304、
 * 没有发布版本 → 404 no_release；只认 Bearer ADMIN_HELPDESK_TOKEN。令牌是本地测试值。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(() => Promise.resolve(null)),
}));
void resolveSession;

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'helpdesk-contract.json'), 'utf8'),
) as {
  portalToAdmin: {
    faqReleaseRequest: string;
    faqReleaseResponse: FaqRelease;
    faqReleaseResponseHeaders: Record<string, string>;
    faqReleaseNotModified: { ifNoneMatch: string; status: number };
    noReleaseProblem: { status: number; code: string };
  };
};
const wire = fixture.portalToAdmin;
const TOKEN = 'test-admin-helpdesk-token-local-only';

/** 契约里那一版存成双语快照（中文是本地测试值；英文 label 只在选项上覆盖）。 */
function storedRelease(): PublishedFaqRelease {
  const expected = wire.faqReleaseResponse;
  const questions = new Map(expected.nodes.map((n) => [n.id, n.question]));
  return {
    version: expected.version,
    publishedAt: expected.publishedAt,
    snapshot: {
      nodes: expected.nodes.map((node: FaqNode) =>
        freezeNode({
          id: node.id,
          key: node.key,
          type: node.type,
          entry: node.entry,
          category: node.category,
          popular: node.popular,
          questionEn: node.question,
          answerEn: node.answer,
          questionZh: `问：${node.key}`,
          answerZh:
            node.type === 'answer'
              ? `答：${node.key}\n\n- 第一步\n- 第二步`
              : '是哪一种？',
          signals: node.signals,
          // 检索与差异用的字段（不发给 Portal）
          keywords: [],
          version: 1,
          updatedAt: expected.publishedAt,
        }),
      ),
      edges: expected.edges.map((edge: FaqEdge) => ({
        parentId: edge.parentId,
        childId: edge.childId,
        kind: edge.kind,
        position: edge.position,
        labelEn: edge.label === questions.get(edge.childId) ? null : edge.label,
        labelZh: edge.kind === 'option' ? `选项 ${edge.position}` : null,
      })),
      phrasings: [
        {
          faqId: expected.nodes[1].id,
          locale: 'zh-TW',
          text: '付款失敗怎麼辦',
        },
      ],
    },
  };
}

describe('FAQ release snapshot → what Portal reads (pure)', () => {
  it('projects the stored bilingual snapshot to exactly the contract release (en-GB)', () => {
    expect(publicRelease(storedRelease(), 'en-GB')).toEqual(
      wire.faqReleaseResponse,
    );
  });

  it('picks the zh-CN text, blocks and labels; a label without an override is the child question', () => {
    const zh = publicRelease(storedRelease(), 'zh-CN');
    expect(zh.locale).toBe('zh-CN');
    const failed = zh.nodes[1];
    expect(failed.question).toBe('问：payment-failed');
    expect(failed.blocks).toEqual([
      { id: 'b1', text: '答：payment-failed' },
      { id: 'b2', text: '- 第一步\n- 第二步' },
    ]);
    expect(zh.edges.map((e) => e.label)).toEqual([
      '选项 0',
      '选项 1',
      '问：charged-twice',
      '问：contact-support',
      '问：contact-support',
    ]);
    // no phrasings go to Portal
    expect(Object.keys(zh).sort()).toEqual(
      ['edges', 'locale', 'nodes', 'publishedAt', 'version'].sort(),
    );
  });

  it('the contract blocks are what the release-time split gives; choice nodes have none', () => {
    for (const node of wire.faqReleaseResponse.nodes) {
      expect(node.blocks).toEqual(
        node.type === 'answer' ? splitAnswerBlocks(node.answer) : [],
      );
    }
    // a 4-block answer exists, so the contract's excerpt (b2-b3) is a real excerpt
    expect(
      wire.faqReleaseResponse.nodes.some((n) => n.blocks.length >= 4),
    ).toBe(true);
  });

  it('every edge joins two nodes of the snapshot; options leave choice nodes, follow-ups leave answers', () => {
    const byId = new Map(wire.faqReleaseResponse.nodes.map((n) => [n.id, n]));
    for (const edge of wire.faqReleaseResponse.edges) {
      expect(byId.has(edge.parentId) && byId.has(edge.childId)).toBe(true);
      expect(byId.get(edge.parentId)?.type).toBe(
        edge.kind === 'option' ? 'choice' : 'answer',
      );
    }
  });

  it('the ETag is "v<version>" whatever the locale, and If-None-Match (list, weak, *) is not-modified', async () => {
    const source: FaqReleaseSource = {
      current: () => Promise.resolve(storedRelease()),
    };
    expect(faqReleaseEtag(3)).toBe(wire.faqReleaseResponseHeaders.ETag);
    for (const locale of ['en-GB', 'zh-CN']) {
      const result = await currentRelease(source, locale, undefined);
      expect(result).toMatchObject({
        kind: 'ok',
        etag: '"v3"',
        notModified: false,
      });
    }
    for (const header of ['"v3"', 'W/"v3"', '"v2", "v3"', '*']) {
      expect(await currentRelease(source, 'en-GB', header)).toMatchObject({
        notModified: true,
      });
    }
    expect(await currentRelease(source, 'en-GB', '"v2"')).toMatchObject({
      notModified: false,
    });
    await expect(
      currentRelease(noFaqReleases, 'en-GB', undefined),
    ).resolves.toEqual({
      kind: 'none',
    });
    await expect(currentRelease(source, 'fr', undefined)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
  });
});

let source: FaqReleaseSource = noFaqReleases;

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [HelpdeskIntegrationFaqReleaseController],
  providers: [
    {
      provide: HELPDESK_FAQ_RELEASE_SOURCE,
      useValue: { current: () => source.current() },
    },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class ReleaseTestModule {}

describe('GET /api/integration/helpdesk/faq-release/current', () => {
  let app: INestApplication<App>;
  const savedToken = process.env.ADMIN_HELPDESK_TOKEN;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ReleaseTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (savedToken === undefined) delete process.env.ADMIN_HELPDESK_TOKEN;
    else process.env.ADMIN_HELPDESK_TOKEN = savedToken;
  });

  beforeEach(() => {
    process.env.ADMIN_HELPDESK_TOKEN = TOKEN;
    source = { current: () => Promise.resolve(storedRelease()) };
  });

  const get = (path = wire.faqReleaseRequest) =>
    request(server()).get(path).set('Authorization', `Bearer ${TOKEN}`);

  it('serves the contract release as plain JSON with the contract headers', async () => {
    const res = await get().expect(200);
    expect(res.body).toEqual(wire.faqReleaseResponse);
    for (const [name, value] of Object.entries(wire.faqReleaseResponseHeaders))
      expect(res.headers[name.toLowerCase()]).toBe(value);
  });

  it('answers 304 with no body for the contract If-None-Match', async () => {
    const res = await get()
      .set('If-None-Match', wire.faqReleaseNotModified.ifNoneMatch)
      .expect(wire.faqReleaseNotModified.status);
    expect(res.text ?? '').toBe('');
    expect(res.headers.etag).toBe(wire.faqReleaseResponseHeaders.ETag);
  });

  it('answers 404 problem+json no_release before the first release', async () => {
    source = noFaqReleases;
    const res = await get().expect(wire.noReleaseProblem.status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject(wire.noReleaseProblem);
  });

  it('answers 400 invalid_request for a missing or unknown locale', async () => {
    for (const path of [
      '/api/integration/helpdesk/faq-release/current',
      '/api/integration/helpdesk/faq-release/current?locale=fr',
      '/api/integration/helpdesk/faq-release/current?locale=en-GB&locale=zh-CN',
    ]) {
      const res = await get(path).expect(400);
      expect(res.body).toMatchObject({ code: 'invalid_request' });
    }
  });

  it('only takes the integration bearer token (401 without or with a wrong one, 503 when unset)', async () => {
    await request(server()).get(wire.faqReleaseRequest).expect(401);
    await request(server())
      .get(wire.faqReleaseRequest)
      .set('Authorization', 'Bearer wrong')
      .expect(401);
    process.env.ADMIN_HELPDESK_TOKEN = ' ';
    const res = await get().expect(503);
    expect(res.body).toMatchObject({ code: 'integration_disabled' });
  });
});
