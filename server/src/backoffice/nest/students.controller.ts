import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';

import { StudentsError } from '../modules/students/portalStudentsClient';
import type { StudentsService } from '../modules/students/studentsService';
import { signedInEmployee as signedIn } from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const STUDENTS_SERVICE = Symbol('STUDENTS_SERVICE');

/** StudentsError → HttpException { code, message }（全局过滤器输出统一信封）。 */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StudentsError) {
      throw new HttpException(
        { code: error.code, message: error.message },
        error.status,
      );
    }
    throw error;
  }
}

/**
 * Student 菜单（PRD §3–§6）：学员列表、详情、单人 Learning Access、账号操作。
 * BackofficeAccessGuard 按菜单 student 校验：GET = VIEW（所有能看菜单的角色），写 = FULL（Admin / Operation Admin）。
 */
@Controller('students')
export class BackofficeStudentsController {
  constructor(
    @Inject(STUDENTS_SERVICE) private readonly students: StudentsService,
  ) {}

  @Get()
  list(
    @Query('q') q?: unknown,
    @Query('status') status?: unknown,
    @Query('subscription') subscription?: unknown,
    @Query('special') special?: unknown,
    @Query('page') page?: unknown,
    @Query('pageSize') pageSize?: unknown,
  ) {
    return run(() =>
      this.students.list({ q, status, subscription, special, page, pageSize }),
    );
  }

  @Get(':studentId')
  detail(@Param('studentId') studentId: string) {
    return run(() => this.students.detail(studentId));
  }

  @Put(':studentId/feature-overrides')
  saveOverrides(
    @Req() request: BackofficeRequest,
    @Param('studentId') studentId: string,
    @Body() body: unknown,
  ) {
    const employee = signedIn(request);
    return run(() => this.students.saveOverrides(employee, studentId, body));
  }

  @Post(':studentId/actions')
  @HttpCode(200)
  act(
    @Req() request: BackofficeRequest,
    @Param('studentId') studentId: string,
    @Body() body: unknown,
  ) {
    const employee = signedIn(request);
    return run(() => this.students.act(employee, studentId, body));
  }
}

/**
 * Settings › Learning Access & Experiments（PRD §7）：全局默认与紧急关闭。
 * 守卫按菜单 settings 校验：GET = VIEW（只读角色可看），写 = FULL（Admin / Operation Admin）。
 */
@Controller('learning-access')
export class BackofficeLearningAccessController {
  constructor(
    @Inject(STUDENTS_SERVICE) private readonly students: StudentsService,
  ) {}

  @Get()
  settings() {
    return run(() => this.students.settings());
  }

  @Put()
  save(@Req() request: BackofficeRequest, @Body() body: unknown) {
    const employee = signedIn(request);
    return run(() => this.students.saveSettings(employee, body));
  }

  @Post('emergency')
  @HttpCode(200)
  emergency(@Req() request: BackofficeRequest, @Body() body: unknown) {
    const employee = signedIn(request);
    return run(() => this.students.emergency(employee, body));
  }
}
