import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';

interface PlanInput {
  id?: string;
  name: string;
  termMonths: number;
  amountMinor: number;
  currency?: string;
  lookupKey?: string;
}

export interface StripeSyncResult {
  planId: string;
  status: 'SYNCED' | 'FAILED' | 'NOT_CONFIGURED';
  productId?: string | null;
  priceId?: string | null;
  error?: string | null;
}

/** 套餐周期 → Stripe recurring。 */
export function stripeRecurring(termMonths: number): {
  interval: 'month' | 'year';
  interval_count: number;
} {
  if (termMonths === 12) return { interval: 'year', interval_count: 1 };
  return { interval: 'month', interval_count: Math.max(1, termMonths) };
}

/** PRD §14：lookup key 格式 `CourseID_周期`（如 C001_1m、C001_12m）。 */
export function stripeLookupKey(
  courseCode: string,
  termMonths: number,
): string {
  return `${courseCode}_${termMonths}m`;
}

/**
 * Pricing（PRD §14）。
 * - 价格不属于版本快照；保存不生成版本。
 * - 每门课一个 Stripe Product；每个套餐一个订阅 Price（USD）。
 * - 金额不可修改：改价时停用旧 Price，用同一 lookup key 新建 Price。
 * - Stripe 失败只记录 syncError，不阻断保存/发布；前端显示 Failed / Retry。
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  // 同一进程内串行化“为一门课创建 Stripe Product”，避免首次保存多套餐时并发创建多个 Product。
  private readonly productLocks = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  async list(courseId: string) {
    await this.assertCourse(courseId);
    return this.prisma.coursePlan.findMany({
      where: { courseId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async save(courseId: string, input: PlanInput[]) {
    const course = await this.assertCourse(courseId);
    if (input.length > 20) {
      throw new ConflictException({
        code: 'TOO_MANY_PLANS',
        message: 'Too many plans.',
      });
    }
    for (const plan of input) {
      if (!plan.name?.trim()) {
        throw new ConflictException({
          code: 'PLAN_NAME_REQUIRED',
          message: 'Plan name is required.',
        });
      }
      if (!Number.isInteger(plan.termMonths) || plan.termMonths <= 0) {
        throw new ConflictException({
          code: 'PLAN_TERM_INVALID',
          message: 'Billing period must be a positive number of months.',
        });
      }
      if (!Number.isInteger(plan.amountMinor) || plan.amountMinor <= 0) {
        throw new ConflictException({
          code: 'PLAN_AMOUNT_INVALID',
          message: 'Amount must be greater than 0.',
        });
      }
    }

    const existing = await this.prisma.coursePlan.findMany({
      where: { courseId, active: true },
    });
    const keepIds = new Set(
      input.map((plan) => plan.id).filter((id): id is string => Boolean(id)),
    );
    const removed = existing.filter((plan) => !keepIds.has(plan.id));

    await this.prisma.$transaction(async (tx) => {
      if (removed.length > 0) {
        await tx.coursePlan.updateMany({
          where: { id: { in: removed.map((plan) => plan.id) } },
          data: { active: false },
        });
      }
      for (const [index, plan] of input.entries()) {
        const lookupKey =
          plan.lookupKey?.trim() ||
          stripeLookupKey(course.code, plan.termMonths);
        const data = {
          courseId,
          name: plan.name.trim(),
          scope: 'COURSE',
          scopeId: courseId,
          termMonths: plan.termMonths,
          device: 'WEB',
          amountMinor: plan.amountMinor,
          currency: (plan.currency ?? 'usd').toLowerCase(),
          stripeLookupKey: lookupKey,
          sortOrder: index,
          active: true,
        };
        if (plan.id) {
          const owned = existing.find((row) => row.id === plan.id);
          if (!owned) {
            throw new NotFoundException({
              code: 'PLAN_NOT_FOUND',
              message: 'Plan not found.',
            });
          }
          await tx.coursePlan.update({ where: { id: plan.id }, data });
        } else {
          await tx.coursePlan.create({ data: { id: randomUUID(), ...data } });
        }
      }
    });

    const plans = await this.list(courseId);
    const sync = await Promise.all(
      plans.map((plan) => this.syncPlan(courseId, plan.id)),
    );
    return { plans: await this.list(courseId), sync };
  }

  /** 保存价格时自动创建/更新 Stripe Product + Price；失败只记录不抛出。 */
  async syncPlan(courseId: string, planId: string): Promise<StripeSyncResult> {
    const course = await this.assertCourse(courseId);
    const plan = await this.prisma.coursePlan.findFirst({
      where: { id: planId, courseId, active: true },
    });
    if (!plan)
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'Plan not found.',
      });

    if (!this.config.stripeSecretKey) {
      const error = 'Stripe is not configured for this environment.';
      await this.prisma.coursePlan.update({
        where: { id: plan.id },
        data: { syncError: error },
      });
      return { planId: plan.id, status: 'NOT_CONFIGURED', error };
    }

    try {
      const productId = await this.ensureCourseProduct(
        course,
        plan.stripeProductId,
      );
      let priceId = plan.stripePriceId;
      const recurring = stripeRecurring(plan.termMonths);
      const lookupKey =
        plan.stripeLookupKey || stripeLookupKey(course.code, plan.termMonths);

      const needsNewPrice =
        !priceId ||
        (await this.priceChanged(
          priceId,
          plan.amountMinor,
          plan.currency,
          recurring,
        ));
      if (needsNewPrice) {
        if (priceId) await this.deactivatePrice(priceId);
        priceId = await this.createPrice({
          productId,
          amountMinor: plan.amountMinor,
          currency: plan.currency,
          recurring,
          lookupKey,
          planId: plan.id,
          courseCode: course.code,
        });
      }

      await this.prisma.coursePlan.update({
        where: { id: plan.id },
        data: {
          stripeProductId: productId,
          stripePriceId: priceId,
          stripeLookupKey: lookupKey,
          lastSyncedAt: new Date(),
          syncError: null,
        },
      });
      return { planId: plan.id, status: 'SYNCED', productId, priceId };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Stripe sync failed.';
      this.logger.error(
        `Stripe sync failed for plan ${plan.id}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.prisma.coursePlan.update({
        where: { id: plan.id },
        data: { syncError: message },
      });
      return { planId: plan.id, status: 'FAILED', error: message };
    }
  }

  private async assertCourse(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true, code: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    return course;
  }

  /**
   * 每门课只允许一个 Stripe Product（PRD §14.2）。
   * 优先复用课程下任一套餐已有的 product id；没有则创建一次，并挂到所有尚未同步的套餐上。
   */
  private async ensureCourseProduct(
    course: { id: string; code: string },
    preferred?: string | null,
  ): Promise<string> {
    if (preferred) return preferred;

    const existing = await this.prisma.coursePlan.findFirst({
      where: {
        courseId: course.id,
        active: true,
        stripeProductId: { not: null },
      },
      select: { stripeProductId: true },
    });
    if (existing?.stripeProductId) return existing.stripeProductId;

    const inflight = this.productLocks.get(course.id);
    if (inflight) return inflight;

    const task = (async () => {
      // 锁内再查一次，覆盖并发请求在等待期间已完成创建的情况。
      const again = await this.prisma.coursePlan.findFirst({
        where: {
          courseId: course.id,
          active: true,
          stripeProductId: { not: null },
        },
        select: { stripeProductId: true },
      });
      if (again?.stripeProductId) return again.stripeProductId;

      const product = await this.stripe('POST', '/v1/products', {
        name: course.code,
        'metadata[course_id]': course.id,
        'metadata[course_code]': course.code,
      });
      const productId = String(product.id);
      await this.prisma.coursePlan.updateMany({
        where: {
          courseId: course.id,
          active: true,
          stripeProductId: null,
        },
        data: { stripeProductId: productId },
      });
      return productId;
    })();

    this.productLocks.set(course.id, task);
    try {
      return await task;
    } finally {
      this.productLocks.delete(course.id);
    }
  }

  private async priceChanged(
    priceId: string,
    amountMinor: number,
    currency: string,
    recurring: { interval: string; interval_count: number },
  ): Promise<boolean> {
    try {
      const price = (await this.stripe(
        'GET',
        `/v1/prices/${encodeURIComponent(priceId)}`,
      )) as {
        unit_amount?: number;
        currency?: string;
        recurring?: { interval?: string; interval_count?: number };
      };
      return (
        Number(price.unit_amount) !== amountMinor ||
        String(price.currency).toLowerCase() !== currency.toLowerCase() ||
        price.recurring?.interval !== recurring.interval ||
        Number(price.recurring?.interval_count ?? 1) !==
          recurring.interval_count
      );
    } catch {
      return true;
    }
  }

  private async deactivatePrice(priceId: string): Promise<void> {
    await this.stripe('POST', `/v1/prices/${encodeURIComponent(priceId)}`, {
      active: 'false',
    });
  }

  private async createPrice(input: {
    productId: string;
    amountMinor: number;
    currency: string;
    recurring: { interval: string; interval_count: number };
    lookupKey: string;
    planId: string;
    courseCode: string;
  }): Promise<string> {
    const price = await this.stripe('POST', '/v1/prices', {
      product: input.productId,
      currency: input.currency,
      unit_amount: String(input.amountMinor),
      'recurring[interval]': input.recurring.interval,
      'recurring[interval_count]': String(input.recurring.interval_count),
      lookup_key: input.lookupKey,
      'metadata[course_plan_id]': input.planId,
      'metadata[course_code]': input.courseCode,
    });
    return String(price.id);
  }

  private async stripe(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const key = this.config.stripeSecretKey;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured.');
    const url = `https://api.stripe.com${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const payload = (await response.json()) as {
      error?: { message?: string };
    } & Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        payload.error?.message ?? `Stripe request failed (${response.status}).`,
      );
    }
    return payload;
  }
}
