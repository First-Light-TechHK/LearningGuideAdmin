import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

/** 全局 Tag 词库（开发文档 §5.1.6） */
@Controller('tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  findAll() {
    return this.tagsService.findAll();
  }

  @Post()
  create(@Body() dto: CreateTagDto) {
    return this.tagsService.create(dto);
  }

  @Put(':name')
  update(@Param('name') name: string, @Body() dto: UpdateTagDto) {
    return this.tagsService.update(name, dto);
  }

  @Delete(':name')
  remove(@Param('name') name: string) {
    return this.tagsService.remove(name);
  }
}
