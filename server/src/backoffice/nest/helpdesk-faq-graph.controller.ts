import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import type { FaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import type { FaqReleaseService } from '../modules/helpdesk/faqs/faqReleaseService';
import { runHelpdesk as run, signedInEmployee } from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const HELPDESK_FAQ_GRAPH_SERVICE = Symbol('HELPDESK_FAQ_GRAPH_SERVICE');
export const HELPDESK_FAQ_RELEASE_SERVICE = Symbol(
  'HELPDESK_FAQ_RELEASE_SERVICE',
);

/**
 * FAQ 问题树员工端（helpdesk-v5-faq-graph-design §5，待视觉验收的编辑器与树视图用）。
 * 守卫与 FAQs 一样：菜单 helpDesk，GET = VIEW，其余写操作 = FULL（route-access.ts 的 /api/helpdesk/**）；
 * 修改人一律是当前登录员工。写操作都幂等：同一对父子再建一次、同一种问法再加一次返回已有的；
 * 删已经没有的 = 成功；工作表没变时「发布新版本」返回最新的那一版；已发布的再发布 / 回滚到当前来源 = 原样返回。
 * - 节点字段（key、type、entry、signals）走 PUT /api/helpdesk/faqs/:id（helpdesk-faqs.controller.ts）。
 */
@Controller('helpdesk')
export class BackofficeHelpdeskFaqGraphController {
  constructor(
    @Inject(HELPDESK_FAQ_GRAPH_SERVICE)
    private readonly graph: FaqGraphService,
    @Inject(HELPDESK_FAQ_RELEASE_SERVICE)
    private readonly releases: FaqReleaseService,
  ) {}

  // ------------------------------------------------------------------- 边

  @Get('faqs/:faqId/edges')
  edges(@Param('faqId') faqId: string) {
    return run(() => this.graph.edges(faqId));
  }

  /** 201 新建；200 这对父子已有同样的边（幂等）。 */
  @Post('faqs/:faqId/edges')
  async createEdge(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    const { edge, created } = await run(() =>
      this.graph.createEdge(employee, faqId, body),
    );
    response.status(created ? 201 : 200);
    return edge;
  }

  @Put('faqs/:faqId/edges/order')
  reorder(
    @Req() request: BackofficeRequest,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.graph.reorder(employee, faqId, body));
  }

  @Get('faqs/:faqId/edge-revisions')
  edgeRevisions(@Param('faqId') faqId: string) {
    return run(() => this.graph.edgeRevisions(faqId));
  }

  @Put('faq-edges/:edgeId')
  updateEdge(
    @Req() request: BackofficeRequest,
    @Param('edgeId') edgeId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.graph.updateEdge(employee, edgeId, body));
  }

  @Delete('faq-edges/:edgeId')
  deleteEdge(
    @Req() request: BackofficeRequest,
    @Param('edgeId') edgeId: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.graph.deleteEdge(employee, edgeId));
  }

  @Get('faqs/:faqId/tree')
  tree(@Param('faqId') faqId: string) {
    return run(() => this.graph.tree(faqId));
  }

  // ----------------------------------------------------------------- 问法

  @Get('faqs/:faqId/phrasings')
  phrasings(@Param('faqId') faqId: string) {
    return run(() => this.graph.phrasings(faqId));
  }

  /** 201 新加；200 已经有这一种（幂等）。 */
  @Post('faqs/:faqId/phrasings')
  async addPhrasing(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    const { phrasing, created } = await run(() =>
      this.graph.addPhrasing(employee, faqId, body),
    );
    response.status(created ? 201 : 200);
    return phrasing;
  }

  @Delete('faq-phrasings/:phrasingId')
  deletePhrasing(
    @Req() request: BackofficeRequest,
    @Param('phrasingId') phrasingId: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.graph.deletePhrasing(employee, phrasingId));
  }

  // ------------------------------------------------------------- 发布版本

  @Get('faq-releases')
  releaseList() {
    return run(() => this.releases.list());
  }

  /** 「发布新版本」页面：工作表的检查与和当前发布版本的差异（只读）。 */
  @Get('faq-releases/working')
  working() {
    return run(() => this.releases.working());
  }

  /** ?head=<版本号|working>&base=<版本号>（缺省：工作表 vs 当前发布的）。 */
  @Get('faq-releases/diff')
  diff(@Query('head') head?: unknown, @Query('base') base?: unknown) {
    return run(() => this.releases.diff(head, base));
  }

  /** 201 新建了版本；200 工作表没变，返回已有的那一版。 */
  @Post('faq-releases')
  async createRelease(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const employee = signedInEmployee(request);
    const { release, created } = await run(() =>
      this.releases.create(employee),
    );
    response.status(created ? 201 : 200);
    return release;
  }

  @Get('faq-releases/:version')
  release(@Param('version') version: string) {
    return run(() => this.releases.get(version));
  }

  @Get('faq-releases/:version/diff')
  releaseDiff(
    @Param('version') version: string,
    @Query('base') base?: unknown,
  ) {
    return run(() => this.releases.diff(version, base));
  }

  @Post('faq-releases/:version/check')
  @HttpCode(200)
  check(@Param('version') version: string) {
    return run(() => this.releases.check(version));
  }

  @Post('faq-releases/:version/publish')
  @HttpCode(200)
  publish(
    @Req() request: BackofficeRequest,
    @Param('version') version: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.releases.publish(employee, version));
  }

  /** 201 新建并发布了回滚版本；200 当前上线的已经是它（幂等）。 */
  @Post('faq-releases/:version/rollback')
  async rollback(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('version') version: string,
  ) {
    const employee = signedInEmployee(request);
    const { release, created } = await run(() =>
      this.releases.rollback(employee, version),
    );
    response.status(created ? 201 : 200);
    return release;
  }
}
