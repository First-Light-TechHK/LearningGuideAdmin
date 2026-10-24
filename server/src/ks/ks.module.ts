import { DynamicModule, Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { FilesModule } from '../files/files.module';
import { PagesModule } from '../pages/pages.module';
import { ReleasesModule } from '../releases/releases.module';
import { SyncModule } from '../sync/sync.module';
import { TagsModule } from '../tags/tags.module';
import { KsInternalController } from './ks-internal.controller';
import { PrismaKnowledgeClient } from './prisma-knowledge.client';

/**
 * KS Engine：知识编写（员工经 Admin 使用）+ 给 Agent 的内部接口。
 * 两部分按角色分别挂载，见 src/app-roles.ts。
 */
@Module({})
export class KsModule {
  static register(options: {
    authoring: boolean;
    internalApi: boolean;
  }): DynamicModule {
    return {
      module: KsModule,
      imports: options.authoring
        ? [
            CoursesModule,
            PagesModule,
            ReleasesModule,
            SyncModule,
            FilesModule,
            TagsModule,
          ]
        : [],
      controllers: options.internalApi ? [KsInternalController] : [],
      providers: [PrismaKnowledgeClient],
    };
  }
}
