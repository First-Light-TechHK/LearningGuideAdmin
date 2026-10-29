import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** 创建 Page（开发文档 §5.1.2、§2 Page 模型；2026-10-16 移除页面级 tags） */
export class CreatePageDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  /** 核心 Markdown 内容，支持 LaTeX（KaTeX 渲染由前端负责） */
  @IsString()
  contentMd!: string;

  /** H1-H6 级标签映射：{ "h{n}-slug": ["tag1"] }（2026-10-16） */
  @IsOptional()
  @IsObject()
  sectionTags?: Record<string, string[]>;

  /** 排序权重；缺省时追加到末尾 */
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
