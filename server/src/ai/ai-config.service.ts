import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CourseAiConfig } from '@prisma/client';
import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { SaveAiConfigDto } from './dto/save-config.dto';
import {
  DEFAULT_PROMPTS,
  defaultWelcome,
  promptTemplateSeeds,
  type PromptMode,
} from './prompt-defaults';

/** 单模式的 AI 配置视图（2026-10-20 二次改拍：System Prompt / Welcome / Model 按模式分开） */
export interface AiModeView {
  /** 自定义覆盖值（null = 未自定义，前端回退该模式模板默认值） */
  systemPrompt: string | null;
  welcomeMsg: string | null;
  /** 该模式生效模型（自定义 ?? AI_AVAILABLE_MODELS[0]） */
  model: string;
}

/** 对外的 AI 配置视图：apiKey 永不明文返回（§2 红线），只暴露是否已配置 */
export interface AiConfigView {
  courseId: string;
  /** 「测试所选 Release」id（Course.aiTestReleaseId ?? currentReleaseId；§5.2，2026-10-20） */
  releaseId: string | null;
  /** 「测试所选 Release」的 versionTag（§4.3.1 对话头部展示） */
  releaseTag: string | null;
  /** 测试所选 Release 是否为上线版本（决定头部徽章 Testing / Live，§4.3.1） */
  isLive: boolean;
  llmProvider: string;
  /** 是否对用户侧开放（课程级，§4.2.6；2026-10-20 由 CourseAiConfig.online 搬到 Course.aiTutorOnline） */
  online: boolean;
  hasApiKey: boolean;
  /** Lecture 模式的配置（§4.2.1–§4.2.3） */
  lecture: AiModeView;
  /** Socratic 模式的配置 */
  socratic: AiModeView;
}

/** 「管理所有 online」弹窗的行视图（§4.2.6） */
export interface AiTutorListView {
  courseId: string;
  title: string;
  online: boolean;
}

/** Portal 学员侧可见的 AI Tutor（2026-10-22） */
export interface LearnerTutorView {
  /** Portal course.slug */
  externalId: string;
  courseId: string;
  title: string;
  /** 课程级 Online 开关 */
  online: boolean;
  /** 真正可用 = online && 存在上线 Release；Portal 用此字段决定是否展示入口 */
  available: boolean;
}

export interface ResolvedPrompts {
  systemPrompt: string;
  welcomeMsg: string;
}

/**
 * 默认 PromptTemplate 视图（2026-10-26）。
 * 库中缺少某模式默认行时由 `src/ai/prompts/` 文件默认值合成，**不写库**，
 * 保证云端空库（未执行 `prompts:sync`）时后台配置页与对话都不空白。
 */
export interface PromptTemplateView {
  id: string;
  mode: PromptMode;
  systemPrompt: string;
  welcomeMsg: string;
  isDefault: boolean;
}

/** 学员端欢迎语语言（默认模板按语言从 src/ai/prompts/welcome.yaml 取） */
export type WelcomeLocale = 'zh-CN' | 'en-GB';

/** 课程级关键字段（用于解析「测试所选 Release」与 Online 状态） */
interface CourseRef {
  id: string;
  currentReleaseId: string | null;
  aiTestReleaseId: string | null;
  aiTutorOnline: boolean;
}

/** PromptTemplate.mode 在库中是自由字符串（§2），仅这两个值参与默认模板 */
function toPromptMode(mode: string): PromptMode | null {
  return mode === 'LECTURE' || mode === 'SOCRATIC' ? mode : null;
}

@Injectable()
export class AiConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    // 课程与 Release 归 KS 所有，只经契约读写（docs/Engine_Split_Implementation.md）
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
  ) {}

  defaultModel(): string {
    return this.availableModels()[0] ?? 'openai/gpt-4o-mini';
  }

  availableModels(): string[] {
    const raw = this.config.get<string>('AI_AVAILABLE_MODELS') ?? '';
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : ['openai/gpt-4o-mini'];
  }

  /**
   * 默认模板列表：库中已有的优先，缺失的模式按文件默认值合成（2026-10-26，只读不写库）。
   * 库内某字段为空串时同样按文件默认值补齐，避免后台仍显示空白。
   * 合成行使用 `lecture-default` / `socratic-default` 固定 id，与 seed / prompts:sync 一致。
   */
  async listPrompts(): Promise<PromptTemplateView[]> {
    const rows = await this.prisma.promptTemplate.findMany({
      where: { isDefault: true },
      orderBy: { mode: 'asc' },
    });
    // 过滤非法 mode，并收窄类型（库列为 String）
    const stored = rows.flatMap((row) => {
      const mode = toPromptMode(row.mode);
      return mode ? [{ ...row, mode }] : [];
    });
    const seeds = new Map(
      promptTemplateSeeds().map((seed) => [seed.mode, seed]),
    );
    const views = stored.map((row) => {
      const seed = seeds.get(row.mode);
      return {
        id: row.id,
        mode: row.mode,
        systemPrompt: row.systemPrompt || seed?.systemPrompt || '',
        welcomeMsg: row.welcomeMsg || seed?.welcomeMsg || '',
        isDefault: row.isDefault,
      };
    });
    const storedModes = new Set(stored.map((row) => row.mode));
    const fallbacks = promptTemplateSeeds()
      .filter((seed) => !storedModes.has(seed.mode))
      .map(({ id, mode, systemPrompt, welcomeMsg, isDefault }) => ({
        id,
        mode,
        systemPrompt,
        welcomeMsg,
        isDefault,
      }));
    return [...views, ...fallbacks].sort((a, b) =>
      a.mode.localeCompare(b.mode),
    );
  }

  /** §5.2：获取某 Course 的 AI 配置（作用于「测试所选 Release」；无配置行时返回默认视图） */
  async getConfig(courseId: string): Promise<AiConfigView> {
    const course = await this.ensureCourse(courseId);
    const releaseId = this.testReleaseIdOf(course);
    const cfg = releaseId
      ? await this.prisma.courseAiConfig.findUnique({
          where: { courseId_releaseId: { courseId, releaseId } },
        })
      : null;
    return await this.toView(course, cfg, releaseId);
  }

  /**
   * §4.2.5（2026-10-20 二次改拍）：保存配置到「测试所选 Release」那一份的**当前模式**。
   * 只写该模式的 System Prompt / Welcome Message / Model 三列；llmProvider / apiKey 课程共享。
   * apiKey 加密入库（省略=不变、空串=清除）。
   */
  async saveConfig(dto: SaveAiConfigDto): Promise<AiConfigView> {
    const course = await this.ensureCourse(dto.courseId);
    const releaseId = this.requireReleaseId(course);
    const existing = await this.prisma.courseAiConfig.findUnique({
      where: { courseId_releaseId: { courseId: dto.courseId, releaseId } },
    });

    let apiKeyField = existing?.apiKey ?? null;
    if (dto.apiKey !== undefined) {
      apiKeyField = dto.apiKey === '' ? null : this.crypto.encrypt(dto.apiKey);
    }

    // 只写当前模式那一组三列（另一模式的值保持不变）
    const modeFields =
      dto.mode === 'LECTURE'
        ? {
            lectureSystemPrompt: dto.systemPrompt || null,
            lectureWelcomeMsg: dto.welcomeMsg || null,
            lectureModel: dto.llmModel,
          }
        : {
            socraticSystemPrompt: dto.systemPrompt || null,
            socraticWelcomeMsg: dto.welcomeMsg || null,
            socraticModel: dto.llmModel,
          };

    const data = {
      llmProvider: dto.llmProvider,
      apiKey: apiKeyField,
      ...modeFields,
    };
    const cfg = await this.prisma.courseAiConfig.upsert({
      where: { courseId_releaseId: { courseId: dto.courseId, releaseId } },
      create: { courseId: dto.courseId, releaseId, ...data },
      update: data,
    });
    return await this.toView(course, cfg, releaseId);
  }

  /**
   * §4.2.4（2026-10-20 二次改拍）：重置 = 清除「测试所选 Release」中**当前模式**的自定义覆盖，
   * 恢复该模式默认模板（System Prompt / Welcome 清空回退模板，Model 回退默认模型）；另一模式不受影响。
   */
  async resetConfig(
    courseId: string,
    mode: 'LECTURE' | 'SOCRATIC',
  ): Promise<AiConfigView> {
    const course = await this.ensureCourse(courseId);
    const releaseId = this.requireReleaseId(course);
    const modeFields =
      mode === 'LECTURE'
        ? {
            lectureSystemPrompt: null,
            lectureWelcomeMsg: null,
            lectureModel: null,
            lectureModeId: null,
          }
        : {
            socraticSystemPrompt: null,
            socraticWelcomeMsg: null,
            socraticModel: null,
            socraticModeId: null,
          };
    const cfg = await this.prisma.courseAiConfig.upsert({
      where: { courseId_releaseId: { courseId, releaseId } },
      create: {
        courseId,
        releaseId,
        llmProvider: 'openrouter',
        ...modeFields,
      },
      update: modeFields,
    });
    return await this.toView(course, cfg, releaseId);
  }

  /**
   * §5.2（2026-10-20 新增）：设置「测试所选 Release」（后台 AI Tutor 测试对话读此 Release 快照）。
   * 持久化到 Course.aiTestReleaseId；返回最新视图。
   */
  async setActiveRelease(
    courseId: string,
    releaseId: string,
  ): Promise<AiConfigView> {
    await this.ensureCourse(courseId);
    const release = await this.knowledge.getReleaseMeta(releaseId);
    if (!release || release.courseId !== courseId) {
      throw new NotFoundException('发布版本不存在或不属于该课程');
    }
    const updated = await this.knowledge.setTestRelease(courseId, releaseId);
    const cfg = await this.prisma.courseAiConfig.findUnique({
      where: { courseId_releaseId: { courseId, releaseId } },
    });
    return await this.toView(updated, cfg, releaseId);
  }

  /**
   * §4.2.6：设置某 Course 的 Online 状态（课程级，与 Release 无关；开关即时生效）。
   * 写 Course.aiTutorOnline（2026-10-20 由 CourseAiConfig.online 搬移而来）。
   */
  async setOnline(courseId: string, online: boolean): Promise<AiConfigView> {
    await this.ensureCourse(courseId);
    const updated = await this.knowledge.setTutorOnline(courseId, online);
    const releaseId = this.testReleaseIdOf(updated);
    const cfg = releaseId
      ? await this.prisma.courseAiConfig.findUnique({
          where: { courseId_releaseId: { courseId, releaseId } },
        })
      : null;
    return await this.toView(updated, cfg, releaseId);
  }

  /** §4.2.6/§5.2：列出全部 AI Tutor（Course）及其 Online 状态（读 Course.aiTutorOnline） */
  async listTutors(): Promise<AiTutorListView[]> {
    const courses = await this.knowledge.listCourses();
    return courses.map((c) => ({
      courseId: c.id,
      title: c.title,
      online: c.aiTutorOnline,
    }));
  }

  /**
   * 用户侧 AI Tutor 列表（§4.2.6/§5.2，2026-10-22 实现）。
   * 返回所有已映射 Portal 的课程；`available` = online && 有上线 Release。
   * Portal 依据 `available` 决定是否展示入口。不做缓存，开关切换后立即生效。
   */
  async listOnlineTutorsForUser(): Promise<LearnerTutorView[]> {
    const courses = await this.knowledge.listCourses({ mappedOnly: true });

    return courses.map((course) => ({
      externalId: course.externalId as string,
      courseId: course.id,
      title: course.title,
      online: course.aiTutorOnline,
      available: course.aiTutorOnline && Boolean(course.currentReleaseId),
    }));
  }

  /**
   * Portal 学员端欢迎语（2026-10-22）：按 externalId 匹配课程，只读上线 Release，
   * 返回 Lecture / Socratic 两种模式生效的 welcome（自定义优先、模板兜底）。
   */
  async resolveLearnerWelcome(
    externalId: string,
    locale: WelcomeLocale = 'zh-CN',
  ): Promise<{ lecture: string; socratic: string }> {
    const course = await this.knowledge.getCourseByExternalId(externalId);
    if (!course) throw new NotFoundException('课程不存在');
    if (!course.aiTutorOnline) {
      throw new ForbiddenException('该课程 AI 导师未开放');
    }
    if (!course.currentReleaseId) {
      throw new ConflictException('该课程尚未发布可用版本');
    }
    const [lecture, socratic] = await Promise.all([
      this.resolveModeWelcome(course.id, course.currentReleaseId, 'LECTURE', locale),
      this.resolveModeWelcome(course.id, course.currentReleaseId, 'SOCRATIC', locale),
    ]);
    return { lecture, socratic };
  }

  /**
   * 单模式 welcome：课程自定义 > 课程绑定模板 > 默认模板。
   * 默认模板（isDefault）按 locale 从 src/ai/prompts/welcome.yaml 取，避免中英文互相覆盖。
   */
  private async resolveModeWelcome(
    courseId: string,
    releaseId: string | null,
    mode: 'LECTURE' | 'SOCRATIC',
    locale: WelcomeLocale,
  ): Promise<string> {
    const cfg = releaseId
      ? await this.prisma.courseAiConfig.findUnique({
          where: { courseId_releaseId: { courseId, releaseId } },
        })
      : null;
    const custom =
      mode === 'LECTURE' ? cfg?.lectureWelcomeMsg : cfg?.socraticWelcomeMsg;
    if (custom) return custom;

    const templateId =
      mode === 'LECTURE' ? cfg?.lectureModeId : cfg?.socraticModeId;
    const template = templateId
      ? await this.prisma.promptTemplate.findUnique({ where: { id: templateId } })
      : await this.prisma.promptTemplate.findFirst({
          where: { mode, isDefault: true },
        });
    if (template && !template.isDefault) return template.welcomeMsg;
    return defaultWelcome(mode, locale);
  }

  /**
   * 对话用有效提示词解析（§4.4.2 第 4 步）：
   * 自定义 > 课程绑定模板 > 默认模板（isDefault）。按「测试所选 Release」取配置。
   */
  async resolvePrompts(
    courseId: string,
    releaseId: string | null,
    mode: 'LECTURE' | 'SOCRATIC',
  ): Promise<ResolvedPrompts> {
    const cfg = releaseId
      ? await this.prisma.courseAiConfig.findUnique({
          where: { courseId_releaseId: { courseId, releaseId } },
        })
      : null;
    const templateId =
      mode === 'LECTURE' ? cfg?.lectureModeId : cfg?.socraticModeId;
    const template = templateId
      ? await this.prisma.promptTemplate.findUnique({ where: { id: templateId } })
      : await this.prisma.promptTemplate.findFirst({
          where: { mode, isDefault: true },
        });
    // 按模式取自定义覆盖（2026-10-20 二次改拍）
    const customPrompt =
      mode === 'LECTURE' ? cfg?.lectureSystemPrompt : cfg?.socraticSystemPrompt;
    const customWelcome =
      mode === 'LECTURE' ? cfg?.lectureWelcomeMsg : cfg?.socraticWelcomeMsg;
    // 库中无模板时回退 `src/ai/prompts/` 文件默认值（2026-10-26）：
    // 云端空库未跑 `prompts:sync` 时，对话仍拿到完整教学 System Prompt，而不是空串。
    return {
      systemPrompt:
        customPrompt ||
        template?.systemPrompt ||
        DEFAULT_PROMPTS[mode].systemPrompt,
      welcomeMsg:
        customWelcome || template?.welcomeMsg || defaultWelcome(mode, 'zh-CN'),
    };
  }

  /** 对话用运行参数：Provider/模型/明文 key（该 Release 配置解密，回退 env 全局）/baseUrl（模型按模式） */
  async resolveRuntime(
    courseId: string,
    releaseId: string | null,
    mode: 'LECTURE' | 'SOCRATIC',
  ): Promise<{
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
  }> {
    const cfg = releaseId
      ? await this.prisma.courseAiConfig.findUnique({
          where: { courseId_releaseId: { courseId, releaseId } },
        })
      : null;
    const apiKey = cfg?.apiKey
      ? this.crypto.decrypt(cfg.apiKey)
      : (this.config.get<string>('OPENROUTER_API_KEY') ?? '');
    if (!apiKey) {
      throw new NotFoundException(
        '未配置可用的 LLM API Key（课程级未设置且 OPENROUTER_API_KEY 缺失）',
      );
    }
    const modeModel =
      mode === 'LECTURE' ? cfg?.lectureModel : cfg?.socraticModel;
    return {
      provider: cfg?.llmProvider ?? 'openrouter',
      model: modeModel ?? this.defaultModel(),
      apiKey,
      baseUrl:
        this.config.get<string>('OPENROUTER_BASE_URL') ??
        'https://openrouter.ai/api/v1',
    };
  }

  /** 解析「测试所选 Release」id：Course.aiTestReleaseId ?? currentReleaseId（§5.2） */
  private testReleaseIdOf(course: CourseRef): string | null {
    return course.aiTestReleaseId ?? course.currentReleaseId;
  }

  /** 保存/重置配置必须有可绑定的 Release，否则拒绝（§5.2 边界） */
  private requireReleaseId(course: CourseRef): string {
    const releaseId = this.testReleaseIdOf(course);
    if (!releaseId) {
      throw new BadRequestException(
        '该课程尚未发布知识库版本，无法保存或重置 AI 配置（请先创建 Release）',
      );
    }
    return releaseId;
  }

  private async toView(
    course: CourseRef,
    cfg: CourseAiConfig | null,
    releaseId: string | null,
  ): Promise<AiConfigView> {
    let releaseTag: string | null = null;
    if (releaseId) {
      const release = await this.knowledge.getReleaseMeta(releaseId);
      releaseTag = release?.versionTag ?? null;
    }
    return {
      courseId: course.id,
      releaseId,
      releaseTag,
      isLive: releaseId != null && releaseId === course.currentReleaseId,
      llmProvider: cfg?.llmProvider ?? 'openrouter',
      // 2026-10-20 二次改拍：System Prompt / Welcome / Model 按模式分组返回
      lecture: {
        systemPrompt: cfg?.lectureSystemPrompt ?? null,
        welcomeMsg: cfg?.lectureWelcomeMsg ?? null,
        model: cfg?.lectureModel ?? this.defaultModel(),
      },
      socratic: {
        systemPrompt: cfg?.socraticSystemPrompt ?? null,
        welcomeMsg: cfg?.socraticWelcomeMsg ?? null,
        model: cfg?.socraticModel ?? this.defaultModel(),
      },
      hasApiKey: Boolean(cfg?.apiKey),
      online: course.aiTutorOnline,
    };
  }

  private async ensureCourse(courseId: string): Promise<CourseRef> {
    const found = await this.knowledge.getCourse(courseId);
    if (!found) throw new NotFoundException('课程不存在');
    return found;
  }
}
