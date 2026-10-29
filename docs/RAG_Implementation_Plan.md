# AI Tutor RAG（检索增强生成）实施规划

| 项目 | 内容 |
|------|------|
| 文档编号 | LG-KS-RAG-20261026 |
| 版本 | v1.0 |
| 日期 | 2026-10-26 |
| 状态 | 规划已定稿，待实施 |
| 触发需求 | 支持 500 页英文教材（如《Modeling Life》）作为 AI Tutor 知识库 |

---

## 0. 背景与现状

### 0.1 当前实现的问题

当前 AI Tutor 的上下文注入策略是**全文塞入（Context Stuffing）**：

- `AiChatService.buildContext()` 遍历 Release 快照的所有 Page，将全部 Markdown 内容拼接后塞进 system prompt
- 无任何检索、分块筛选、向量搜索
- 对短课程（几页到几十页）可工作，但对 500 页教材（约 50 万~100 万 tokens）会超出模型上下文窗口

### 0.2 设计文档中的目标方案

系统设计文档（`system-design-v3-20261024.md`）已明确 RAG 架构：

- 向量数据库：pgvector，`knowledge_chunk.embedding` 字段
- 向量索引：HNSW
- 检索 topK：Tutor = 6
- 相似度阈值：score_threshold = 0.35
- 上下文预算：8k tokens
- 引用输出：`citations:[{chunkId, pageTitle}]`

KS WP1 综合实施报告明确分块参数：

- chunk max_tokens = 800
- overlap = 80 tokens

---

## 1. 技术选型

| 维度 | 选型 | 理由 |
|------|------|------|
| 向量数据库 | **pgvector** | 复用现有 PostgreSQL，无需引入新数据库 |
| Embedding 模型 | **OpenAI text-embedding-3-small** | 1536 维，英文教材质量优秀，成本极低 |
| Embedding 通道 | **OpenRouter**（复用 `OPENROUTER_API_KEY`） | 减少配置项，复用已验证链路 |
| 向量维度 | **1536** | 与 text-embedding-3-small 输出对齐（设计文档表 48 的 1024 为旧值，实施时按 1536 建表） |
| 分块策略 | **标题感知 + 滑动窗口** | 教材有清晰章节结构，按 H1-H6 切分保证语义完整性 |
| 分块大小 | **800 tokens，overlap 80** | 对齐 KS WP1 §3.1 |

### 1.1 为什么不用本地开源模型

当前阶段优先用 OpenAI API，理由：
- 零运维，质量有保证
- 成本极低（500 页书一次性约 $0.01-0.02，每次查询约 $0.000001）
- 如未来有隐私合规要求，可迁移到 BGE-M3（需重建向量表）

---

## 2. 数据模型设计

### 2.1 KnowledgeChunk 表（新增）

```prisma
model KnowledgeChunk {
  id          String   @id @default(uuid())
  releaseId   String
  release     Release  @relation(fields: [releaseId], references: [id], onDelete: Cascade)
  pageId      String?   // 原 Page ID（追溯用）
  pageTitle   String    // 页面标题（引用展示用）
  heading     String?   // 所属 H1-H6 标题（引用展示用）
  content     String   @db.Text   // 分块纯文本
  embedding   Unsupported("vector(1536)")  // pgvector 1536 维
  sortOrder   Int       // 页面内顺序
  tokenCount  Int       // token 估算（上下文预算用）
  createdAt   DateTime  @default(now())

  @@index([releaseId])
  @@index([releaseId, sortOrder])
}
```

### 2.2 关键设计决策

- **Chunk 绑定 Release（不是 Page）**：AI Tutor 只读 Release 快照，Release 不可变，chunk 也随之不可变；删除 Release 时级联删除 chunks
- **pgvector 类型**：Prisma 用 `Unsupported("vector(1536)")`，向量操作走 `$queryRaw`
- **HNSW 索引**：`CREATE INDEX ON "KnowledgeChunk" USING hnsw (embedding vector_cosine_ops);`

---

## 3. 分块策略

### 3.1 流程

```
1. 按 H1-H6 切分 Markdown（复用现有 splitByHeadings）
2. 每个 heading 段内，按 token 数滑动窗口：
   - 目标 chunk 大小：~800 tokens
   - 重叠：~80 tokens（保留跨段上下文）
3. 记录每个 chunk 的 pageTitle、heading、sortOrder
```

### 3.2 Token 估算

用 `~4 chars/token` 近似估算（英文文本较准），或引入 `tiktoken` 库精确计算。

---

## 4. 发布流程改造

### 4.1 异步索引

在 `ReleasesService.publish()` 创建 Release 后，**异步触发** chunking + embedding：

```
publish() 原有逻辑：
  1. 创建 Release（snapshotData）  ← 不变
  2. 置 editingReleaseId          ← 不变

新增（第 3 步，异步，void 不阻塞）：
  3. 遍历 snapshot.pages
  4. 对每个 page 执行 chunking
  5. 批量调用 embedding API
  6. 写入 KnowledgeChunk 表
```

### 4.2 失败处理

- 索引失败记录日志，不影响 Release 创建
- 本期先做日志记录，后续提供手动"重建索引"接口

---

## 5. 检索与上下文注入

### 5.1 检索服务

```sql
SELECT "pageTitle", "heading", "content",
       1 - (embedding <=> $1) AS score
FROM "KnowledgeChunk"
WHERE "releaseId" = $2
ORDER BY embedding <=> $1
LIMIT $3
```

参数：topK=6，score_threshold=0.35

### 5.2 上下文格式

```
[CONTEXT_START]

[Source: {pageTitle} - {heading}]
{chunk content}

[Source: {pageTitle} - {heading}]
{chunk content}

[CONTEXT_END]
```

### 5.3 Token 预算控制

总预算 8k tokens，累加 chunks 的 tokenCount，超出时按 score 从高到低截断。

### 5.4 Prompt 引用规则

在 Lecture 和 Socratic 的 system prompt 末尾追加：

```
CITATION RULE:
When you use information from the context, cite the source at the end of the relevant sentence
in the format: [Source: Chapter X - Section Title].
Only cite sources that appear in [CONTEXT_START]...[CONTEXT_END].
If the answer is general knowledge not from the context, do not add a citation.
```

---

## 6. 实施阶段

| Phase | 内容 | 产出 |
|-------|------|------|
| **P1** | pgvector 扩展 + Prisma schema + migration | 数据库就绪，KnowledgeChunk 表可写入向量 |
| **P2** | EmbeddingService（OpenRouter text-embedding-3-small） | 可调用 embedding API，返回 1536 维向量 |
| **P3** | ChunkingService + IndexingService + 发布时异步建索引 | 上传 PDF 后自动建索引 |
| **P4** | RetrievalService + 改造 buildContext + prompt 引用规则 | AI Tutor 基于检索回答，带引用 |
| **P5** | 用《Modeling Life》实测，调整参数 | 生产可用 |

---

## 7. 风险与应对

| 风险 | 应对 |
|------|------|
| 发布时异步索引失败 | 失败记录日志，提供手动重建索引接口（后续） |
| 检索 0 结果 | 回退到"通用解释"模式，不阻塞对话 |
| pgvector 扩展未安装 | migration 中 `CREATE EXTENSION IF NOT EXISTS` |
| 现有课程无 chunks | 提供一次性补建索引脚本 |

---

## 8. 配置项

| 配置 | 值 | 说明 |
|------|-----|------|
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | embedding 模型 |
| `EMBEDDING_BATCH_SIZE` | 100 | 每批 embedding 的文本数 |
| `CHUNK_TARGET_TOKENS` | 800 | 分块目标 token 数 |
| `CHUNK_OVERLAP_TOKENS` | 80 | 分块重叠 token 数 |
| `RETRIEVAL_TOP_K` | 6 | 检索数量 |
| `RETRIEVAL_SCORE_THRESHOLD` | 0.35 | 相似度阈值 |
| `CONTEXT_TOKEN_BUDGET` | 8000 | 上下文 token 预算 |
