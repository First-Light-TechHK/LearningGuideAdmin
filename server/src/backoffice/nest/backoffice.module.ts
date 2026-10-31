import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
  Provider,
} from '@nestjs/common';

import {
  HELPDESK_GAP_LABELLER,
  noGapLabeller,
  type GapLabeller,
} from '../../contracts/helpdesk-flywheel';

import { closePool } from '../lib/db';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import { HELPDESK_FAQ_RELEASE_SOURCE } from '../modules/helpdesk/faqs/faqRelease';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../modules/helpdesk/faqs/faqReleaseService';
import { createPgFaqMapRepository } from '../modules/helpdesk/faqs/faqMapRepository';
import {
  createFaqService,
  type FaqService,
} from '../modules/helpdesk/faqs/faqService';
import { sharedFaqVectorSearch } from '../modules/helpdesk/faqs/faqVectors';
import { createHelpdeskService } from '../modules/helpdesk/helpdeskService';
import { createPgCandidateRepository } from '../modules/helpdesk/flywheel/candidateRepository';
import { createFaqCandidateService } from '../modules/helpdesk/flywheel/faqCandidateService';
import {
  createJobRunner,
  createPgJobLock,
  createPgJobRunRepository,
  startFlywheelScheduler,
  type JobRunner,
} from '../modules/helpdesk/flywheel/flywheelJobs';
import { createFlywheelMetrics } from '../modules/helpdesk/flywheel/flywheelMetrics';
import { createFlywheelRunsService } from '../modules/helpdesk/flywheel/flywheelRunsService';
import {
  createFlywheelService,
  workingNodeTexts,
} from '../modules/helpdesk/flywheel/flywheelService';
import { createPgInsightRepository } from '../modules/helpdesk/flywheel/insightRepository';
import { createPortalHelpdeskClient } from '../modules/helpdesk/portalHelpdeskClient';
import { tryRecordAuditEvent } from '../repositories/auditRepository';
import {
  bootstrapAdminFromEnv,
  initialiseSessionSecret,
} from '../modules/user-authentication/services/bootstrap';
import { BackofficeAuthController } from './auth.controller';
import { BackofficeEmployeesController } from './employees.controller';
import { BackofficeHelpdeskAgentRunsController } from './helpdesk-agent-runs.controller';
import {
  BackofficeHelpdeskFaqGraphController,
  HELPDESK_FAQ_GRAPH_SERVICE,
  HELPDESK_FAQ_RELEASE_SERVICE,
} from './helpdesk-faq-graph.controller';
import { HelpdeskIntegrationFaqReleaseController } from './helpdesk-faq-release.controller';
import {
  BackofficeHelpdeskFlywheelController,
  HELPDESK_FAQ_CANDIDATE_SERVICE,
  HELPDESK_FLYWHEEL_METRICS,
  HELPDESK_FLYWHEEL_RUNS_SERVICE,
} from './helpdesk-flywheel.controller';
import {
  BackofficeHelpdeskController,
  HELPDESK_SERVICE,
} from './helpdesk.controller';
import {
  BackofficeHelpdeskFaqsController,
  HELPDESK_FAQ_SERVICE,
  HelpdeskIntegrationFaqsController,
} from './helpdesk-faqs.controller';

/**
 * BackOffice Portal（PRD v1.1）：员工登录、员工账号、六角色菜单权限、语言偏好；
 * HelpDesk 工单（设计文档 §4A，经 Portal 集成接口读写）；
 * FAQ 库（Tickets v2 §1–§3，本模块是唯一写入方；Portal 经集成接口读已发布的，Agent 经契约
 * HelpdeskQaSource 读候选）；「查看链路」经契约 HelpdeskTraceSource 读 Agent 的事件日志。
 * 全局守卫 BackofficeAccessGuard 在 AppModule 注册。
 */
export type BackofficeModuleOptions = {
  /** HELPDESK_TRACE_SOURCE 的提供者（AppModule 组装：Agent 的事件日志 → 导出副本）。 */
  helpdeskTrace: Provider;
  /**
   * HELPDESK_GAP_LABELLER 的提供者（AppModule 组装：Agent 的一次小模型调用；没有 key / 测试 = 不问模型）。
   * 不给 = 不问模型（代码写的标签）。
   */
  gapLabeller?: Provider;
};

const HELPDESK_FLYWHEEL_RUNNER = Symbol('HELPDESK_FLYWHEEL_RUNNER');

/**
 * 夜间缺口挖掘的进程内调度（v5 Part G3）：应用启动完成后才开始（第一次检查在 2–3 分钟后，定时器
 * unref，不阻塞启动也不拖住退出）；几个实例同时跑时由 advisory lock 与当天的运行行保证只跑一次。
 */
@Injectable()
export class HelpdeskFlywheelScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private scheduler: { stop(): void } | null = null;

  constructor(
    @Inject(HELPDESK_FLYWHEEL_RUNNER) private readonly runner: JobRunner,
  ) {}

  onApplicationBootstrap(): void {
    // 测试里不起调度（调度本身由 helpdesk-flywheel-jobs.spec.ts 用假定时器测）
    if (process.env.NODE_ENV === 'test') return;
    this.scheduler = startFlywheelScheduler({
      tick: () => this.runner.runScheduled('gap_mining'),
    });
  }

  onApplicationShutdown(): void {
    this.scheduler?.stop();
  }
}

@Module({})
export class BackofficeModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BackofficeModule.name);

  static register(options: BackofficeModuleOptions): DynamicModule {
    // v5 问题树：同一个仓库与发布来源（快照按版本缓存）给 FAQ、问题树、发布与 Portal 的 faq-release/current
    const graph = createPgFaqGraphRepository();
    const releaseSource = createPgFaqReleaseSource(graph);
    return {
      module: BackofficeModule,
      controllers: [
        BackofficeAuthController,
        BackofficeEmployeesController,
        BackofficeHelpdeskController,
        BackofficeHelpdeskFaqsController,
        BackofficeHelpdeskFaqGraphController,
        HelpdeskIntegrationFaqsController,
        HelpdeskIntegrationFaqReleaseController,
        BackofficeHelpdeskAgentRunsController,
        BackofficeHelpdeskFlywheelController,
      ],
      providers: [
        {
          provide: HELPDESK_SERVICE,
          useFactory: () => createHelpdeskService(),
        },
        {
          provide: HELPDESK_FAQ_SERVICE,
          // 第一版发布之后 Portal 读的 FAQ 只来自那一版快照；归档前查还在用它的父节点
          useFactory: () =>
            createFaqService({
              releaseVersion: () => releaseSource.publishedVersion(),
              liveParents: (id) => graph.liveParents(id),
            }),
        },
        {
          provide: HELPDESK_FAQ_GRAPH_SERVICE,
          useFactory: () => createFaqGraphService({ graph }),
        },
        {
          provide: HELPDESK_FAQ_RELEASE_SERVICE,
          useFactory: () => createFaqReleaseService({ graph }),
        },
        // 已发布快照：还没有任何发布版本时 current() 为 null（Portal 收到 404 no_release，照旧读逐条发布的 FAQ）
        { provide: HELPDESK_FAQ_RELEASE_SOURCE, useValue: releaseSource },
        options.helpdeskTrace,
        options.gapLabeller ?? {
          provide: HELPDESK_GAP_LABELLER,
          useValue: noGapLabeller,
        },
        // v5 Part G：数据飞轮（事实表 ← Portal insights；候选；运行行；指标）
        {
          provide: HELPDESK_FLYWHEEL_RUNNER,
          useFactory: (labeller: GapLabeller) => {
            const flywheel = createFlywheelService({
              portal: createPortalHelpdeskClient(),
              insights: createPgInsightRepository(),
              candidates: createPgCandidateRepository(),
              nodes: () => workingNodeTexts(graph),
              labeller,
            });
            return createJobRunner({
              runs: createPgJobRunRepository(),
              lock: createPgJobLock(),
              work: { gap_mining: () => flywheel.nightly() },
            });
          },
          inject: [HELPDESK_GAP_LABELLER],
        },
        {
          provide: HELPDESK_FAQ_CANDIDATE_SERVICE,
          useFactory: (labeller: GapLabeller, faqs: FaqService) => {
            const insights = createPgInsightRepository();
            return createFaqCandidateService({
              candidates: createPgCandidateRepository(),
              graph,
              graphService: createFaqGraphService({ graph }),
              portal: createPortalHelpdeskClient(),
              nodes: () => workingNodeTexts(graph),
              map: createPgFaqMapRepository(),
              faqs,
              shownCards: (turnIds) => insights.shownCards(turnIds),
              // 审核页的相似卡：和线上检索同一份向量索引（没配向量模型 → 文字相似度）
              vectors: {
                search: sharedFaqVectorSearch(),
                release: () => releaseSource.publishedVersion(),
              },
              labeller,
            });
          },
          inject: [HELPDESK_GAP_LABELLER, HELPDESK_FAQ_SERVICE],
        },
        {
          provide: HELPDESK_FLYWHEEL_RUNS_SERVICE,
          useFactory: (runner: JobRunner) =>
            createFlywheelRunsService({
              runs: createPgJobRunRepository(),
              runner,
              portal: createPortalHelpdeskClient(),
              audit: tryRecordAuditEvent,
            }),
          inject: [HELPDESK_FLYWHEEL_RUNNER],
        },
        {
          provide: HELPDESK_FLYWHEEL_METRICS,
          useFactory: () =>
            createFlywheelMetrics({
              insights: createPgInsightRepository(),
              graph,
            }),
        },
        HelpdeskFlywheelScheduler,
      ],
    };
  }

  async onModuleInit(): Promise<void> {
    await initialiseSessionSecret();
    if ((await bootstrapAdminFromEnv()) === 'CREATED') {
      this.logger.log('Bootstrap admin created from BOOTSTRAP_ADMIN_EMAIL');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await closePool();
  }
}
