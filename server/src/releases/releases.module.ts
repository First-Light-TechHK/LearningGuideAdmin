import { DynamicModule, Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProfessorQaIndexService } from '../knowledge/professor-qa-index.service';
import { FilesModule } from '../files/files.module';
import { ReleasesController } from './releases.controller';
import { ReleasesService } from './releases.service';
import { TeachingCardsService } from './teaching-cards.service';
import { ReleasePackagesService } from './release-packages.service';
import {
  TEACHING_PACKAGE_COMPILER,
  type TeachingPackageCompiler,
} from '../ks/contract/teaching-package-compiler';

@Module({
  imports: [KnowledgeModule, FilesModule],
  controllers: [ReleasesController],
})
export class ReleasesModule {
  static register(compiler: TeachingPackageCompiler): DynamicModule {
    return {
      module: ReleasesModule,
      providers: [
        ReleasesService,
        ReleasePackagesService,
        ProfessorQaIndexService,
        TeachingCardsService,
        { provide: TEACHING_PACKAGE_COMPILER, useValue: compiler },
      ],
    };
  }
}
