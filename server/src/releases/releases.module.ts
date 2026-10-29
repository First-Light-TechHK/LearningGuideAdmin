import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ReleasesController } from './releases.controller';
import { ReleasesService } from './releases.service';

@Module({
  imports: [KnowledgeModule],
  controllers: [ReleasesController],
  providers: [ReleasesService],
})
export class ReleasesModule {}
