import { Controller, Get, Inject, Param, Query } from '@nestjs/common';

import type { FaqChangeLogService } from '../modules/helpdesk/faqs/faqChangeLogService';
import { runHelpdesk as run } from './helpdesk-http';

export const HELPDESK_FAQ_CHANGE_LOG_SERVICE = Symbol(
  'HELPDESK_FAQ_CHANGE_LOG_SERVICE',
);

/**
 * FAQ 修改记录（BackOffice Change Log 与 FAQ 抽屉的 History，Figma 草案 2.6–2.9）。只读：
 * 守卫与 FAQs 一样，菜单 helpDesk，GET = VIEW（route-access.ts 的 /api/helpdesk/**），能看 FAQ 的人都能看是谁改的。
 * 记录本身只追加（数据库触发器拒绝改和删），由各个写接口在同一事务里写入。
 */
@Controller('helpdesk')
export class BackofficeHelpdeskFaqChangesController {
  constructor(
    @Inject(HELPDESK_FAQ_CHANGE_LOG_SERVICE)
    private readonly changes: FaqChangeLogService,
  ) {}

  @Get('faq-changes')
  list(
    @Query('subject') subject?: unknown,
    @Query('employee') employee?: unknown,
    @Query('faq') faq?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
    @Query('q') q?: unknown,
    @Query('page') page?: unknown,
    @Query('pageSize') pageSize?: unknown,
  ) {
    return run(() =>
      this.changes.list({
        subject,
        employee,
        faq,
        from,
        to,
        q,
        page,
        pageSize,
      }),
    );
  }

  @Get('faqs/:faqId/changes')
  forFaq(
    @Param('faqId') faqId: string,
    @Query('page') page?: unknown,
    @Query('pageSize') pageSize?: unknown,
  ) {
    return run(() => this.changes.forFaq(faqId, { page, pageSize }));
  }
}
