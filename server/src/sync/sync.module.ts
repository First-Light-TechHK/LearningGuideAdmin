import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { CatalogueSourceService } from './catalogue-source.service';
import { SyncService } from './sync.service';

@Module({
  controllers: [SyncController],
  providers: [SyncService, CatalogueSourceService],
})
export class SyncModule {}
