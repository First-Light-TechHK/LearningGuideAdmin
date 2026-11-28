import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ReleasePackagesService } from './release-packages.service';
import { PACKAGE_BYTES } from './release-package';
import type { Request, Response } from 'express';
import { ReleasesService } from './releases.service';
import { CreateReleaseDto } from './dto/create-release.dto';
import { ActivateReleaseDto } from './dto/activate-release.dto';
import { TeachingCardsService } from './teaching-cards.service';
import {
  readTeachingWorkbook,
  readTeachingWorkbookSheets,
  referenceWordTemplate,
  sheetKind,
  TEACHING_SHEET_BYTES,
  teachingSheetKinds,
  teachingWorkbook,
  teachingWorkbookSheets,
} from './teaching-import-files';
import type { SheetRow } from './teaching-sheet-rows';
import { FilesService } from '../files/files.service';
import { referenceTransferLimits } from './teaching-reference-limits';

const teachingWorkbookUpload = FileInterceptor('file', {
  limits: {
    fileSize: TEACHING_SHEET_BYTES + 1,
    files: 1,
    fields: 1,
    fieldSize: 256 * 1024,
  },
});

function sendTeachingFile(
  response: Response,
  filename: string,
  buffer: Buffer,
) {
  response.setHeader(
    'Content-Disposition',
    "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
  );
  response
    .type(
      filename.endsWith('.xlsx')
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    .send(buffer);
}

type TeachingCardRequest = Request & { employee?: { employeeId: string } };
type WorkbookPick = {
  kind?: unknown;
  row?: unknown;
  id?: unknown;
  revision?: unknown;
  binding?: unknown;
};

function employeeId(request: TeachingCardRequest): string {
  if (!request.employee?.employeeId) throw new UnauthorizedException();
  return request.employee.employeeId;
}

/**
 * §5.1.4 发布与版本。
 * 路由跨 courses 与 releases 两组，故用空前缀 + 完整相对路径声明。
 */
@Controller()
export class ReleasesController {
  constructor(
    private readonly releasesService: ReleasesService,
    private readonly teachingCards: TeachingCardsService,
    private readonly packages: ReleasePackagesService,
    private readonly files: FilesService,
  ) {}

  @Get('releases/:releaseId/package')
  async downloadPackage(@Param('releaseId') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.packages.download(id);
    res.setHeader(
      'Content-Disposition',
      "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
    );
    res.type('application/zip').send(buffer);
  }

  @Post('courses/:id/release-package/:action')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PACKAGE_BYTES + 1, files: 1 },
    }),
  )
  async importPackage(
    @Param('id') id: string,
    @Param('action') action: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file || !['preview', 'apply'].includes(action))
      throw new BadRequestException('请选择知识版本 ZIP');
    return this.packages.import(id, file.buffer, action === 'apply');
  }

  @Get('courses/:id/teaching-cards')
  async listTeachingCards(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stamp, entries } = await this.teachingCards.listWithStamp(id);
    res.setHeader('X-Workspace-Stamp', stamp);
    return entries;
  }

  @Get('courses/:id/teaching-cards/import/deleted-codes')
  deletedReferenceCodes(@Param('id') id: string) {
    return this.teachingCards.deletedReferenceCodes(id);
  }

  @Get('courses/:id/teaching-cards/templates/:kind')
  async teachingTemplate(
    @Param('kind') kind: string,
    @Query('lang') lang: string,
    @Res() response: Response,
  ) {
    if (kind === 'workbook') {
      sendTeachingFile(
        response,
        'Teaching Entries.xlsx',
        teachingWorkbookSheets(
          teachingSheetKinds.map((kind) => ({ kind, rows: [] })),
        ),
      );
      return;
    }
    if (kind === 'latex' || kind === 'image') {
      sendTeachingFile(
        response,
        kind === 'latex' ? 'Formula references.docx' : 'Image references.docx',
        await referenceWordTemplate(kind),
      );
      return;
    }
    const type = sheetKind(kind);
    sendTeachingFile(
      response,
      type === 'concept' ? 'Definitions.xlsx' : 'Professor Q&A.xlsx',
      teachingWorkbook(type, [], lang === 'zh-CN'),
    );
  }

  @Post('courses/:id/teaching-cards/export/:kind')
  async downloadCurrentTeaching(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Query('lang') lang: string,
    @Body('ids') ids: unknown,
    @Body('sheets') sheets: unknown,
    @Res() response: Response,
  ) {
    if (kind === 'workbook') {
      const { filename, buffer } =
        await this.teachingCards.downloadTeachingWorkbook(id, sheets);
      sendTeachingFile(response, filename, buffer);
      return;
    }
    const type = kind === 'latex' || kind === 'image' ? kind : sheetKind(kind);
    const { filename, buffer } = await this.teachingCards.download(
      id,
      type,
      ids,
      lang === 'zh-CN',
    );
    sendTeachingFile(response, filename, buffer);
  }

  @Post('courses/:id/teaching-cards/reference-documents/:kind/preview')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: referenceTransferLimits.image.bytes + 1, files: 1 },
    }),
  )
  previewReferenceFile(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Req() request: TeachingCardRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file || (kind !== 'latex' && kind !== 'image'))
      throw new BadRequestException('TEACHING_REFERENCE_DOCUMENT_INVALID');
    return this.files.previewReferenceDocument(
      file,
      id,
      kind,
      employeeId(request),
    );
  }

  @Post('courses/:id/teaching-cards/reference-documents/finish')
  async finishReferenceFiles(
    @Param('id') id: string,
    @Body('tokens') tokens: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    if (
      !Array.isArray(tokens) ||
      tokens.length > referenceTransferLimits.latex.rows ||
      !tokens.every((token: unknown) => typeof token === 'string')
    )
      throw new BadRequestException('TEACHING_REFERENCE_DOCUMENT_INVALID');
    for (const token of tokens)
      await this.files.finishReferencePreview(id, token, employeeId(request));
    return { finished: true };
  }

  @Get('courses/:id/teaching-cards/:entryId/reference-usage')
  referenceUsage(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Query('revision', ParseIntPipe) revision: number,
  ) {
    return this.teachingCards.deleteSelection(
      id,
      [{ id: entryId, revision }],
      true,
    );
  }

  @Post('courses/:id/teaching-cards/sheets/:kind/preview')
  @UseInterceptors(teachingWorkbookUpload)
  async previewTeachingSheet(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (kind === 'workbook') {
      const { sheets, skippedSheets } = await readTeachingWorkbookSheets(
        this.sheetBuffer(file),
      );
      return {
        ...(await this.teachingCards.previewTeachingWorkbook(id, sheets)),
        skippedSheets,
      };
    }
    const type = sheetKind(kind);
    return this.teachingCards.previewTeachingSheet(
      id,
      type,
      await readTeachingWorkbook(type, this.sheetBuffer(file)),
    );
  }

  @Post('courses/:id/teaching-cards/sheets/:kind/apply')
  @UseInterceptors(teachingWorkbookUpload)
  async applyTeachingSheet(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body('selection') raw: string,
    @Req() request: TeachingCardRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.applySheet(id, kind, raw, request, file, false);
  }

  @Patch('courses/:id/teaching-cards/sheets/:kind/apply')
  @UseInterceptors(teachingWorkbookUpload)
  async updateTeachingSheet(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body('selection') raw: string,
    @Req() request: TeachingCardRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.applySheet(id, kind, raw, request, file, true);
  }

  private async applySheet(
    id: string,
    kind: string,
    raw: string,
    request: TeachingCardRequest,
    file: Express.Multer.File | undefined,
    updatesOnly: boolean,
  ) {
    const picks = this.sheetSelection(raw);
    const employee = employeeId(request);
    const stamp = request.get('X-Workspace-Stamp');
    if (kind === 'workbook') {
      const { sheets } = await readTeachingWorkbookSheets(
        this.sheetBuffer(file),
      );
      const kinds = [...new Set(picks.map((pick) => sheetKind(pick?.kind)))];
      const selections = kinds.map((kind) => {
        const sheet = sheets.find(
          (sheet) => sheet.kind === kind && !sheet.invalid,
        );
        if (!sheet) throw new BadRequestException('TEACHING_SHEET_INVALID');
        return {
          kind,
          items: this.sheetItems(
            sheet.rows,
            picks.filter((pick) => pick.kind === kind),
          ),
        };
      });
      return this.teachingCards.importTeachingWorkbook(
        id,
        selections,
        updatesOnly,
        employee,
        stamp,
      );
    }
    const type = sheetKind(kind);
    const rows = await readTeachingWorkbook(type, this.sheetBuffer(file));
    return this.teachingCards.importTeachingSheet(
      id,
      type,
      this.sheetItems(rows, picks),
      updatesOnly,
      employee,
      stamp,
    );
  }

  private sheetSelection(raw: string) {
    let selection: unknown;
    try {
      selection = JSON.parse(raw);
    } catch {
      throw new BadRequestException('TEACHING_SHEET_INVALID');
    }
    if (!Array.isArray(selection) || !selection.length)
      throw new BadRequestException('TEACHING_SHEET_INVALID');
    return selection as WorkbookPick[];
  }

  private sheetItems(rows: SheetRow[], picks: WorkbookPick[]) {
    if (
      picks.length > rows.length ||
      new Set(picks.map((pick) => pick?.row)).size !== picks.length
    )
      throw new BadRequestException('TEACHING_SHEET_INVALID');
    return picks.map((pick) => {
      const found = rows.find((row) => row.row === pick?.row);
      if (!found || found.errors.length)
        throw new BadRequestException('TEACHING_SHEET_INVALID');
      return {
        row: found.row,
        values: found.values,
        sourceOmitted: found.sourceOmitted,
        id: pick.id,
        revision: pick.revision,
        binding: pick.binding,
        dependencies: found.dependencies,
      };
    });
  }

  private sheetBuffer(file?: Express.Multer.File) {
    if (!file || !/\.xlsx$/i.test(file.originalname))
      throw new BadRequestException('TEACHING_SHEET_INVALID');
    return file.buffer;
  }

  @Post('courses/:id/teaching-cards/import/references')
  importReferences(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.importReferences(
      id,
      items,
      false,
      employeeId(request),
    );
  }

  @Patch('courses/:id/teaching-cards/import/references')
  updateReferences(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.importReferences(
      id,
      items,
      true,
      employeeId(request),
    );
  }

  @Post('courses/:id/teaching-cards/deletion-preview')
  previewTeachingCardDeletion(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Headers('x-workspace-stamp') stamp?: string,
  ) {
    return this.teachingCards.deleteSelection(id, items, true, stamp);
  }

  @Delete('courses/:id/teaching-cards')
  deleteTeachingCards(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Headers('x-workspace-stamp') stamp?: string,
  ) {
    return this.teachingCards.deleteSelection(id, items, false, stamp);
  }

  @Get('courses/:id/teaching-references')
  listTeachingReferences(@Param('id') id: string) {
    return this.teachingCards.listReferences(id);
  }

  @Post('courses/:id/teaching-cards')
  createTeachingCard(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.save(
      id,
      undefined,
      undefined,
      body,
      employeeId(request),
      request.get('X-Workspace-Stamp'),
    );
  }

  @Patch('courses/:id/teaching-cards/:cardId')
  updateTeachingCard(
    @Param('id') id: string,
    @Param('cardId') cardId: string,
    @Body('revision', ParseIntPipe) revision: number,
    @Body('draft') draft: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.save(
      id,
      cardId,
      revision,
      draft,
      employeeId(request),
      request.get('X-Workspace-Stamp'),
    );
  }

  @Post('courses/:id/release')
  publish(@Param('id') id: string, @Body() dto: CreateReleaseDto) {
    return this.releasesService.publish(id, dto);
  }

  @Post('courses/:id/activate-release')
  activate(@Param('id') id: string, @Body() dto: ActivateReleaseDto) {
    return this.releasesService.activate(id, dto);
  }

  /** Set Live（§3.4.4，2026-10-20 新增）：轻量切换上线指针，不重建草稿 */
  @Post('courses/:id/set-live')
  setLive(@Param('id') id: string, @Body() dto: ActivateReleaseDto) {
    return this.releasesService.setLive(id, dto);
  }

  @Get('courses/:id/releases')
  findAllByCourse(@Param('id') id: string) {
    return this.releasesService.findAllByCourse(id);
  }

  @Get('releases/:releaseId')
  findOne(@Param('releaseId') releaseId: string) {
    return this.releasesService.findByReleaseId(releaseId);
  }

  @Post('releases/:releaseId/rebuild-index')
  @HttpCode(HttpStatus.ACCEPTED)
  rebuildIndex(@Param('releaseId') releaseId: string) {
    return this.releasesService.rebuildIndex(releaseId);
  }

  /**
   * 导出 Release 快照为 ZIP（方案 B，2026-10-30 新增）。
   * VIEW 权限即可；纯读，不改动任何 Release / Course 状态。
   * ZIP 根目录每页一个文件；有图片的页面为 DOCX，其余为 MD。
   */
  @Get('releases/:releaseId/export')
  @Header('Content-Type', 'application/zip')
  async exportZip(@Param('releaseId') releaseId: string, @Res() res: Response) {
    const { buffer, filename } =
      await this.releasesService.exportZip(releaseId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  }

  /** 删除版本（§3.4.5，2026-10-20 新增）：Live / 后台测试所选版本返回 409 */
  @Delete('releases/:releaseId')
  remove(@Param('releaseId') releaseId: string) {
    return this.releasesService.remove(releaseId);
  }
}
