import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { signInAs } from './helpers/employee-session';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProviderRegistry } from '../src/ai/providers/provider.registry';
import { LlmStreamOptions } from '../src/ai/providers/llm-provider.interface';

/**
 * AI Tutor 后端 e2e（开发文档 §5.2、§4.4、§7 Phase 5）。
 * Provider 用假适配器（不触网）；配置/加密/限流/SSE 帧格式走真实链路。
 */
describe('AI API (e2e)', () => {
  let app: INestApplication<App>;
  let api: Awaited<ReturnType<typeof signInAs>>;
  let prisma: PrismaService;
  let courseId: string;
  let releaseId: string;
  let lastOpts: LlmStreamOptions | null;

  const fakeProvider = {
    name: 'openrouter',
    async *stream(opts: LlmStreamOptions): AsyncGenerator<string> {
      lastOpts = opts;
      yield 'Hello';
      yield '!';
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ProviderRegistry)
      .useValue({ get: () => fakeProvider })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    api = await signInAs(app);
    prisma = app.get(PrismaService);

    const course = await prisma.course.create({
      data: {
        title: 'AI-E2E课程',
        pages: {
          create: [
            {
              title: '有效页',
              contentMd: '# 有效页\n\nSYNCED-CONTENT $E=mc^2$',
              sortOrder: 0,
            },
            {
              title: '失效页',
              contentMd: 'STALE-CONTENT-SHOULD-BE-EXCLUDED',
              sortOrder: 1,
              syncState: 'STALE',
            },
          ],
        },
      },
    });
    courseId = course.id;

    // 2026-10-20 纯快照改拍（§3.4.3）：Create Release 不再自动激活，
    // 故夹具课程发布后须显式 Set Live，使 chat-stream 知识源读到该 Release 快照。
    // 快照仅含 SYNCED 节点（STALE 被排除在发布之外）。
    const relRes = await api
      .post(`/api/courses/${courseId}/release`)
      .send({ revisionNotes: 'e2e 初始发布' })
      .expect(201);
    releaseId = relRes.body.data.id;
    await api
      .post(`/api/courses/${courseId}/set-live`)
      .send({ releaseId })
      .expect(201);
  });

  afterAll(async () => {
    const courses = await prisma.course.findMany({
      where: { title: { startsWith: 'AI-E2E' } },
      select: { id: true },
    });
    const ids = courses.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.courseAiConfig.deleteMany({
        where: { courseId: { in: ids } },
      });
      await prisma.release.deleteMany({ where: { courseId: { in: ids } } }); // Release 无级联，先删
      await prisma.course.deleteMany({ where: { id: { in: ids } } });
    }
    await app.close();
  });

  it('GET /api/ai/models 返回 env 模型清单（§4.2.3，数据源 AI_AVAILABLE_MODELS）', async () => {
    const res = await api.get('/api/ai/models').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(
      res.body.data.every((m: string) => typeof m === 'string' && m.length > 0),
    ).toBe(true);
  });

  it('GET /api/ai/prompts 返回默认模板（§4.2.4）', async () => {
    const res = await api.get('/api/ai/prompts').expect(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(
      res.body.data.every((t: { isDefault: boolean }) => t.isDefault),
    ).toBe(true);
  });

  it('GET /api/ai/config/:courseId 无配置时返回默认视图且无 apiKey 字段', async () => {
    const res = await api.get(`/api/ai/config/${courseId}`).expect(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        llmProvider: 'openrouter',
        hasApiKey: false,
      }),
    );
    expect(typeof res.body.data.lecture.model).toBe('string');
    expect(typeof res.body.data.socratic.model).toBe('string');
    expect(res.body.data.lecture.systemPrompt).toBeNull();
    // 2026-10-20：回退 currentReleaseId，测试所选 Release 即上线版本 → isLive=true
    expect(res.body.data.releaseId).toBe(releaseId);
    expect(res.body.data.isLive).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('apiKey');
  });

  it('PUT /api/ai/config 加密存储 apiKey，任何响应不含明文（§2 红线）', async () => {
    const res = await api
      .put('/api/ai/config')
      .send({
        courseId,
        mode: 'SOCRATIC',
        llmProvider: 'openrouter',
        llmModel: 'test/model-b',
        systemPrompt: 'CUSTOM-PROMPT',
        welcomeMsg: 'CUSTOM-WELCOME',
        apiKey: 'sk-plain-secret',
      })
      .expect(200);
    expect(res.body.data.hasApiKey).toBe(true);
    // 2026-10-20 二次改拍：只写 SOCRATIC 模式那一组；LECTURE 保持未自定义（按模式隔离）
    expect(res.body.data.socratic.model).toBe('test/model-b');
    expect(res.body.data.socratic.systemPrompt).toBe('CUSTOM-PROMPT');
    expect(res.body.data.socratic.welcomeMsg).toBe('CUSTOM-WELCOME');
    expect(res.body.data.lecture.systemPrompt).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('sk-plain-secret');

    const stored = await prisma.courseAiConfig.findUnique({
      where: { courseId_releaseId: { courseId, releaseId } },
    });
    expect(stored?.apiKey).toBeTruthy();
    expect(stored!.apiKey).not.toContain('sk-plain-secret');
    expect(stored!.apiKey!.split(':')).toHaveLength(3); // iv:tag:cipher
  });

  it('POST /api/ai/chat-stream SSE 流：自定义 Prompt 优先、不再注入固定苏格拉底指令、排除 STALE 内容（§4.4.2）', async () => {
    lastOpts = null;
    const res = await api
      .post('/api/ai/chat-stream')
      .send({ courseId, message: '什么是质能方程？', mode: 'SOCRATIC' })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data: {"delta":"Hello"}');
    expect(res.text).toContain('data: {"delta":"!"}');
    expect(res.text).toContain('data: {"done":true}');

    const system = lastOpts!.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('CUSTOM-PROMPT'); // 自定义优先于模板
    // 2026-10-22：默认模板自带完整教学指令，运行时不再追加固定苏格拉底指令
    expect(system).not.toContain('苏格拉底式的引导者');
    expect(system).toContain('SYNCED-CONTENT');
    expect(system).not.toContain('STALE-CONTENT-SHOULD-BE-EXCLUDED'); // §3.4.3 快照仅含 SYNCED
    expect(lastOpts!.apiKey).toBe('sk-plain-secret'); // 课程级解密值
  });

  it('POST /api/ai/chat-stream 课程未发布知识库版本应 400（§4.3.3 激活版本模型）', async () => {
    const unpublished = await prisma.course.create({
      data: {
        title: 'AI-E2E未发布课',
        pages: {
          create: [{ title: '页', contentMd: 'DRAFT-ONLY', sortOrder: 0 }],
        },
      },
    });
    const res = await api
      .post('/api/ai/chat-stream')
      .send({ courseId: unpublished.id, message: 'hi', mode: 'LECTURE' })
      .expect(400);
    expect(res.body.error.message).toContain('Releases');
    await prisma.course.delete({ where: { id: unpublished.id } });
  });

  it('POST /api/ai/chat-stream 携带 history 时拼入多轮上下文（§4.4.1）', async () => {
    lastOpts = null;
    await api
      .post('/api/ai/chat-stream')
      .send({
        courseId,
        message: '继续',
        mode: 'LECTURE',
        history: [{ role: 'user', content: '上一轮问题' }],
      })
      .expect(200);
    expect(lastOpts!.messages.some((m) => m.content === '上一轮问题')).toBe(
      true,
    );
    const system = lastOpts!.messages[0].content;
    expect(system).not.toContain('苏格拉底式的引导者'); // LECTURE 不注入
  });

  it('POST /api/ai/chat-stream 缺 message 应 400（§4.4.2 第 1 步）', async () => {
    const res = await api
      .post('/api/ai/chat-stream')
      .send({ courseId, mode: 'LECTURE' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/ai/chat-stream 课程不存在应 404', async () => {
    const res = await api
      .post('/api/ai/chat-stream')
      .send({
        courseId: '00000000-0000-0000-0000-000000000000',
        message: 'hi',
        mode: 'LECTURE',
      })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('限流：同一 courseId 每分钟第 11 次请求应 429（§4.4.3）', async () => {
    const rlCourse = await prisma.course.create({
      data: { title: 'AI-E2E限流课' },
    });
    // 限流在知识源校验之前触发（streamChat 第 1 步），但为保持"前 10 次可达链路"语义，先发布空快照
    // 2026-10-20 改拍：AI 配置按 Release 维度保存，故须先发布 Release 再保存配置
    const rlRel = await api
      .post(`/api/courses/${rlCourse.id}/release`)
      .send({ revisionNotes: 'e2e 限流课发布' })
      .expect(201);
    // 纯快照下发布不自动激活，须显式 Set Live 才能保存课程级配置（§3.4.3/§5.2）
    await api
      .post(`/api/courses/${rlCourse.id}/set-live`)
      .send({ releaseId: rlRel.body.data.id })
      .expect(201);
    // 课程级配置 apiKey，避免依赖 env 全局 key
    await api
      .put('/api/ai/config')
      .send({
        courseId: rlCourse.id,
        mode: 'LECTURE',
        llmProvider: 'openrouter',
        llmModel: 'test/model-a',
        apiKey: 'sk-rl-test',
      })
      .expect(200);
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await api
        .post('/api/ai/chat-stream')
        .send({ courseId: rlCourse.id, message: `m${i}`, mode: 'LECTURE' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    await prisma.courseAiConfig.deleteMany({
      where: { courseId: rlCourse.id },
    });
    await prisma.release.deleteMany({ where: { courseId: rlCourse.id } });
    await prisma.course.delete({ where: { id: rlCourse.id } });
  });

  it('POST /api/ai/config/:courseId/reset 清除该模式自定义恢复默认（§4.2.4）', async () => {
    const res = await api
      .post(`/api/ai/config/${courseId}/reset`)
      .send({ mode: 'SOCRATIC' })
      .expect(201);
    expect(res.body.data.socratic.systemPrompt).toBeNull();
    expect(res.body.data.socratic.welcomeMsg).toBeNull();
    expect(res.body.data.hasApiKey).toBe(true); // reset 不清 key
  });

  it('AI 配置按模式隔离：保存/重置只影响当前模式（§4.2.4/§4.2.5，2026-10-20 二次改拍）', async () => {
    // 保存 LECTURE 自定义
    await api
      .put('/api/ai/config')
      .send({
        courseId,
        mode: 'LECTURE',
        llmProvider: 'openrouter',
        llmModel: 'test/model-lec',
        systemPrompt: 'LEC-PROMPT',
        welcomeMsg: 'LEC-WELCOME',
      })
      .expect(200);
    // 保存 SOCRATIC 自定义
    const soc = await api
      .put('/api/ai/config')
      .send({
        courseId,
        mode: 'SOCRATIC',
        llmProvider: 'openrouter',
        llmModel: 'test/model-soc',
        systemPrompt: 'SOC-PROMPT',
        welcomeMsg: 'SOC-WELCOME',
      })
      .expect(200);
    // 两种模式各自保存，互不覆盖
    expect(soc.body.data.lecture.systemPrompt).toBe('LEC-PROMPT');
    expect(soc.body.data.lecture.model).toBe('test/model-lec');
    expect(soc.body.data.socratic.systemPrompt).toBe('SOC-PROMPT');
    expect(soc.body.data.socratic.model).toBe('test/model-soc');

    // 重置 LECTURE → 只清 LECTURE，SOCRATIC 保留
    const r = await api
      .post(`/api/ai/config/${courseId}/reset`)
      .send({ mode: 'LECTURE' })
      .expect(201);
    expect(r.body.data.lecture.systemPrompt).toBeNull();
    expect(r.body.data.lecture.model).not.toBe('test/model-lec'); // 回退默认
    expect(r.body.data.socratic.systemPrompt).toBe('SOC-PROMPT');
    expect(r.body.data.socratic.model).toBe('test/model-soc');
  });

  it('PUT /api/ai/config/:courseId/online 切换 Online 即时生效（§4.2.6）', async () => {
    const on = await api
      .put(`/api/ai/config/${courseId}/online`)
      .send({ online: true })
      .expect(200);
    expect(on.body.data.online).toBe(true);
    const stored = await prisma.course.findUnique({
      where: { id: courseId },
      select: { aiTutorOnline: true },
    });
    expect(stored?.aiTutorOnline).toBe(true);

    const off = await api
      .put(`/api/ai/config/${courseId}/online`)
      .send({ online: false })
      .expect(200);
    expect(off.body.data.online).toBe(false);
  });

  it('PUT /api/ai/config/:courseId/online 非布尔值应 400（§4.2.6/§9.3）', async () => {
    const res = await api
      .put(`/api/ai/config/${courseId}/online`)
      .send({ online: 'yes' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT active-release + POST set-live：测试选中与上线切换（§4.3.1/§3.4.4，2026-10-20）', async () => {
    // 再发布一个 Release（纯快照，不改 Live 指针，§3.4.3）
    const rel2 = await api
      .post(`/api/courses/${courseId}/release`)
      .send({ revisionNotes: 'e2e 第二次发布' })
      .expect(201);
    const release2Id = rel2.body.data.id as string;

    // 将新 Release 设为上线版本（轻量 set-live）→ currentReleaseId=release2Id
    await api
      .post(`/api/courses/${courseId}/set-live`)
      .send({ releaseId: release2Id })
      .expect(201);

    // 测试选中旧 Release（即原 releaseId），其非上线版本 → isLive=false
    const pick = await api
      .put(`/api/ai/config/${courseId}/active-release`)
      .send({ releaseId })
      .expect(200);
    expect(pick.body.data.releaseId).toBe(releaseId);
    expect(pick.body.data.isLive).toBe(false);

    // 归属校验：不存在的 releaseId → 404
    await api
      .put(`/api/ai/config/${courseId}/active-release`)
      .send({ releaseId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);

    // 校验：非法 UUID → 400
    await api
      .put(`/api/ai/config/${courseId}/active-release`)
      .send({ releaseId: 'not-a-uuid' })
      .expect(400);

    // Set Live 旧 Release（轻量：仅切上线指针）
    await api
      .post(`/api/courses/${courseId}/set-live`)
      .send({ releaseId })
      .expect(201);

    // 非法 UUID → 400（ActivateReleaseDto 加 @IsUUID，与 active-release 口径一致）
    await api
      .post(`/api/courses/${courseId}/set-live`)
      .send({ releaseId: 'not-a-uuid' })
      .expect(400);

    // 再看 config → 测试所选 == 上线 → isLive=true
    const after = await api.get(`/api/ai/config/${courseId}`).expect(200);
    expect(after.body.data.releaseId).toBe(releaseId);
    expect(after.body.data.isLive).toBe(true);

    // 清理第二个 Release（其配置行随 CourseAiConfig_releaseId_fkey 级联）
    await prisma.release.delete({ where: { id: release2Id } });
  });

  it('AI 配置按 Release 维度隔离：切换 Release 回显各自保存的配置（§4.2.5/§4.3.1，2026-10-20）', async () => {
    // 独立课程，避免污染共享夹具
    const isoCourse = await prisma.course.create({
      data: { title: 'AI-E2E配置隔离课' },
    });
    // R1：发布后在 R1 保存自定义 prompt/welcome/model/key
    const r1 = await api
      .post(`/api/courses/${isoCourse.id}/release`)
      .send({ revisionNotes: 'R1' })
      .expect(201);
    const r1Id = r1.body.data.id as string;
    // 纯快照下发布不自动激活，须显式选择测试 Release 才能保存配置（§3.4.3/§5.2）
    await api
      .put(`/api/ai/config/${isoCourse.id}/active-release`)
      .send({ releaseId: r1Id })
      .expect(200);
    await api
      .put('/api/ai/config')
      .send({
        courseId: isoCourse.id,
        mode: 'LECTURE',
        llmProvider: 'openrouter',
        llmModel: 'test/model-iso',
        systemPrompt: 'ISO-R1-PROMPT',
        welcomeMsg: 'ISO-R1-WELCOME',
        apiKey: 'sk-iso-r1',
      })
      .expect(200);

    // R2：发布快照 → 切到 R2 → 其 AI 配置来自模板默认（无自定义、无 key）
    const r2 = await api
      .post(`/api/courses/${isoCourse.id}/release`)
      .send({ revisionNotes: 'R2' })
      .expect(201);
    const r2Id = r2.body.data.id as string;

    // 切到 R2 → 回退默认视图
    const atR2 = await api
      .put(`/api/ai/config/${isoCourse.id}/active-release`)
      .send({ releaseId: r2Id })
      .expect(200);
    expect(atR2.body.data.releaseId).toBe(r2Id);
    expect(atR2.body.data.lecture.systemPrompt).toBeNull();
    expect(atR2.body.data.hasApiKey).toBe(false);

    // 切回 R1 → 回显 R1 保存的自定义配置与 key（隔离生效）
    const backR1 = await api
      .put(`/api/ai/config/${isoCourse.id}/active-release`)
      .send({ releaseId: r1Id })
      .expect(200);
    expect(backR1.body.data.lecture.systemPrompt).toBe('ISO-R1-PROMPT');
    expect(backR1.body.data.lecture.welcomeMsg).toBe('ISO-R1-WELCOME');
    expect(backR1.body.data.hasApiKey).toBe(true);

    // 清理（先删 Release：其配置行随 CourseAiConfig_releaseId_fkey 级联；再删 Course）
    await prisma.release.deleteMany({ where: { courseId: isoCourse.id } });
    await prisma.course.delete({ where: { id: isoCourse.id } });
  });

  it('GET /api/ai/tutors 返回全部 AI Tutor 及 Online 状态（§4.2.6）', async () => {
    const res = await api.get('/api/ai/tutors').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const row = res.body.data.find(
      (t: { courseId: string }) => t.courseId === courseId,
    );
    expect(row).toBeTruthy();
    expect(typeof row.title).toBe('string');
    expect(typeof row.online).toBe('boolean');
  });

  it('GET /api/user/ai-tutors 返回用户侧可用性列表且不含敏感字段（§4.2.6/§5.2）', async () => {
    const res = await api.get('/api/user/ai-tutors').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // 仅返回已映射 Portal 的课程（externalId 非空）；每条含 online/available 布尔值
    for (const row of res.body.data) {
      expect(typeof row.externalId).toBe('string');
      expect(typeof row.online).toBe('boolean');
      expect(typeof row.available).toBe('boolean');
    }
    expect(JSON.stringify(res.body)).not.toContain('apiKey');
  });

  it('POST /api/user/ai/chat-stream 学员端：只读 currentReleaseId + 语言指令 + Online 拦截', async () => {
    await prisma.course.update({
      where: { id: courseId },
      data: {
        externalId: 'ai-e2e-learner',
        aiTutorOnline: true,
        currentReleaseId: releaseId,
        aiTestReleaseId: null,
      },
    });

    lastOpts = null;
    const res = await api
      .post('/api/user/ai/chat-stream')
      .send({
        externalCourseId: 'ai-e2e-learner',
        message: 'What is the argument?',
        mode: 'LECTURE',
        locale: 'en-GB',
        history: [],
      })
      .expect(200);
    expect(res.text).toContain('data: {"delta":"Hello"}');
    expect(res.text).toContain('data: {"done":true}');
    expect(lastOpts!.messages[0].content).toContain(
      'Always answer in British English.',
    );

    await prisma.course.update({
      where: { id: courseId },
      data: { aiTutorOnline: false },
    });
    const offline = await api
      .post('/api/user/ai/chat-stream')
      .send({
        externalCourseId: 'ai-e2e-learner',
        message: 'hi',
        mode: 'LECTURE',
        locale: 'en-GB',
      })
      .expect(403);
    expect(offline.body.error.message).toContain('未开放');
  });
});
