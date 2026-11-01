# Portal 只读投影 API 文档

> 版本：v1.1（2026-11-01）  
> 适用范围：Portal 课程列表 / 详情 / 媒体 / 草稿预览  
> 实现位置：`server/src/commerce-courses/portal-courses.controller.ts`、`portal-projection.service.ts`、`portal-preview.service.ts`
>
> **v1.1 变更**：详情补齐 `whatYouLearn` / `provides` / `plans` / `learningMode` / `learningLanguages` / `totalDurationSeconds` / `durationSeconds`；`contents[].url` 从相对 `media/...` 改为 `/api/portal/v1/media/...`；新增封面、媒体和签名预览端点。

Admin 是课程数据的唯一写入方；Portal 通过只读投影 API 拉取**线上版本**内容。  
Portal 页面不应直接读 Admin 的工作区草稿；草稿预览走短时效签名链接。

---

## 1. 端点总览

| Method | Path | 说明 | 鉴权 |
|---|---|---|---|
| `GET` | `/api/portal/v1/courses` | 课程列表（仅 `ONLINE`、已发布、未归档） | `X-API-Key`（部署环境） |
| `GET` | `/api/portal/v1/courses/:id` | 课程详情（来自 `liveVersionId` 快照） | `X-API-Key` |
| `GET` | `/api/portal/v1/media/:courseId/cover` | 课程封面二进制 | `X-API-Key` |
| `GET` | `/api/portal/v1/media/:courseId/assets/:assetId` | 课程视频 / 展品等媒体二进制 | `X-API-Key` |
| `GET` | `/api/portal/v1/preview/course?token=...` | 用签名 token 取草稿 / 指定版本详情（Portal 备用） | `X-API-Key` + preview token |
| `GET` | `/api/backoffice/courses/:id/portal-preview` | Admin 生成课程预览链接（指向 Admin 预览页） | 员工会话 |
| `GET` | `/api/backoffice/courses/:id/portal-preview/content?token=...` | Admin 预览页读取草稿 / 指定版本投影 | 员工会话 + preview token |

### 1.1 列表查询参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `limit` | number | `50` | 返回条数上限 |

### 1.2 统一响应信封

JSON 端点统一返回：

```json
{ "success": true, "data": {}, "error": null, "message": "操作成功" }
```

媒体端点直接返回二进制，不套信封。

---

## 2. 鉴权

`/api/portal/**` 在 `route-access.ts` 中登记为 `service`，由 `ApiKeyGuard` 校验。

| 环境 | `AUTH_ENABLED` | 要求 |
|---|---|---|
| 本地 / 未部署 | `false`（默认） | 无需 Header |
| 已部署 | `true` | `X-API-Key: <AUTH_TOKEN>` |
| 已部署且 `AUTH_TOKEN` 为空 | — | 所有请求被拒绝 |

`/api/backoffice/courses/:id/portal-preview` 走员工会话，按课程菜单的 `VIEW` 权限放行。

---

## 3. 字段覆盖矩阵（对照实际 Portal 详情页）

下表按 `https://www.ilovelearningguide.com/zh-CN/portal/courses/modeling-life` 页面元素逐项映射。

| Portal 页面元素 | Portal 字段 | 数据来源 | 状态 |
|---|---|---|---|
| Hero 封面 | `coverUrl` | 课程封面资产 | ✅ 已补齐媒体端点 |
| 分类 | `category` | `CourseCatalogueEntry.name` | ✅ |
| 标题 | `title` | live 快照本地化 | ✅ |
| 短描述 | `shortDescription` | live 快照本地化 | ✅ |
| 课时数 | `lessonCount` | live 快照 lessons | ✅ |
| 总时长 | `totalDurationSeconds` | live 快照 lesson 视频时长求和 | ✅ 新增 |
| 课程概览 | `description` | live 快照 `overview` | ✅ |
| 你将学到什么 | `whatYouLearn` | live 快照本地化 | ✅ 新增 |
| 课程大纲 | `sections[].lessons[]` | live 快照 lessons | ✅ |
| 课时标题 | `sections[].lessons[].title` | live 快照 lesson 本地化 | ✅ |
| 课时摘要 | `sections[].lessons[].summary` | live 快照 lesson 描述 | ✅ |
| 课时时长 | `sections[].lessons[].durationSeconds` | live 快照视频时长 | ✅ 新增 |
| 试看标记 | `sections[].lessons[].isPublic` + `trial` | 当前环境 `TrialSetting.status='READY'` | ✅ |
| 视频 / 文本内容 | `contents[]` | live 快照 | ✅ |
| 视频 / 展品媒体 | `contents[].url`、`contents[].nodes[].url` | 媒体资产 ID | ✅ 改为 Portal 媒体端点 |
| 本课程提供 | `provides` | live 快照本地化 | ✅ 新增 |
| 订阅计划 | `plans[]` | 当前环境 `CoursePlan.active=true` | ✅ 新增 |
| 计划价格 | `plans[].amountMinor` / `currency` | `CoursePlan` | ✅ |
| 计划周期 | `plans[].termMonths` | `CoursePlan` | ✅ |
| 计划 lookup key | `plans[].lookupKey` | `CoursePlan.stripeLookupKey` | ✅ |
| 学习模式 | `learningMode` | live 快照 | ✅ 新增 |
| 学习语言 | `learningLanguages` | live 快照 | ✅ 新增 |
| 默认内容语言 | `defaultContentLanguage` | live 快照 | ✅ 新增 |

**结论：当前投影已覆盖实际 Portal 详情页所需的课程内容字段。**  
剩余差异主要是 Portal 前端自己的页面组件、SEO、登录/订阅状态，不属于课程内容投影。

---

## 4. 课程列表

### 4.1 请求

```bash
# 本地（AUTH_ENABLED=false）
curl -s "http://localhost:3001/api/portal/v1/courses?limit=10"

# 已部署 dev
curl -s "https://cpzmzuzkkj.ap-southeast-1.awsapprunner.com/api/portal/v1/courses?limit=10" \
  -H "X-API-Key: <AUTH_TOKEN>"
```

### 4.2 过滤规则

只返回同时满足以下条件的课程：

- `liveStatus = ONLINE`
- `liveVersionId != null`
- `archivedAt = null`

列表标题、短描述、概览均来自 **live 版本快照**，不是工作区草稿。

### 4.3 成功响应样例

```json
{
  "success": true,
  "data": [
    {
      "id": "4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2",
      "slug": "modeling-life",
      "code": "C001",
      "title": "Modeling life",
      "subtitle": null,
      "shortDescription": "See how mathematics models life, from population growth to neural activity and disease. Simulate real biological systems with Euler’s method, no prior background in differential equations required.",
      "description": "Centred on dynamical systems and feedback, it shows how differential equations underpin homeostasis, population dynamics, neural activity and disease...",
      "category": "Science",
      "level": null,
      "tags": [],
      "referencePrice": 0,
      "discount": 0,
      "coverUrl": "/api/portal/v1/media/4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2/cover",
      "lessonCount": 2,
      "totalDurationSeconds": 3053,
      "learningMode": "VIDEO_AND_TEXT",
      "learningLanguages": ["en-GB", "zh-CN"]
    }
  ],
  "error": null,
  "message": "操作成功"
}
```

### 4.4 字段说明

| 字段 | 说明 |
|---|---|
| `id` | Admin 内部课程 UUID（详情寻址用） |
| `code` | 对外课程主键（如 `C001`） |
| `slug` | 路由别名 |
| `title` / `shortDescription` / `description` | live 快照默认内容语言 |
| `category` | 课程分类名称 |
| `referencePrice` / `discount` | 价格信息 |
| `coverUrl` | 封面相对路径，Portal 需拼接 Admin origin |
| `lessonCount` | live 快照课时数 |
| `totalDurationSeconds` | live 快照课时视频时长总和 |
| `learningMode` | `VIDEO_ONLY` / `TEXT_ONLY` / `VIDEO_AND_TEXT` |
| `learningLanguages` | 课程支持的学习语言 |

---

## 5. 课程详情

### 5.1 请求

```bash
# 本地
curl -s "http://localhost:3001/api/portal/v1/courses/4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2"

# 已部署 dev
curl -s "https://cpzmzuzkkj.ap-southeast-1.awsapprunner.com/api/portal/v1/courses/4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2" \
  -H "X-API-Key: <AUTH_TOKEN>"
```

`:id` 使用列表返回的课程 `id`（内部 UUID），不是 `code`。

### 5.2 成功响应样例（节选）

```json
{
  "success": true,
  "data": {
    "id": "4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2",
    "slug": "modeling-life",
    "code": "C001",
    "title": "Modeling life",
    "subtitle": null,
    "shortDescription": "See how mathematics models life...",
    "description": "Centred on dynamical systems and feedback...",
    "category": "Science",
    "level": null,
    "tags": [],
    "referencePrice": 0,
    "discount": 0,
    "coverUrl": "/api/portal/v1/media/4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2/cover",
    "learningMode": "VIDEO_AND_TEXT",
    "learningLanguages": ["en-GB", "zh-CN"],
    "defaultContentLanguage": "en-GB",
    "whatYouLearn": [
      "Model real biological systems mathematically.",
      "Understand positive and negative feedback"
    ],
    "provides": [
      { "type": "video", "title": "Video & text dual-mode learning" },
      { "type": "reading", "title": "Extended readings for context" }
    ],
    "lessonCount": 2,
    "totalDurationSeconds": 3053,
    "trial": {
      "enabled": true,
      "lessonIds": ["f992d8f5-1009-44ac-acde-edad50aba91e"]
    },
    "plans": [
      {
        "id": "science-pc-6",
        "name": "Science 6 months",
        "termMonths": 6,
        "amountMinor": 3900,
        "currency": "usd",
        "lookupKey": "C001_6m",
        "trialEligible": true
      }
    ],
    "sections": [
      {
        "id": "all",
        "title": "Lessons",
        "lessons": [
          {
            "id": "f992d8f5-1009-44ac-acde-edad50aba91e",
            "title": "State Spaces, Vector Spaces and Trajectories",
            "summary": "A system can be thought of as a collection of states at different times.",
            "durationSeconds": 1469,
            "isPublic": true,
            "contents": [
              {
                "id": "L001-video",
                "type": "video",
                "mode": "lecture",
                "url": "/api/portal/v1/media/4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2/assets/0b40587c-02d2-489d-ab09-3e33f7d836e4",
                "nodes": [
                  {
                    "id": "E0101",
                    "title": "E0101",
                    "type": "image",
                    "url": "/api/portal/v1/media/4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2/assets/22516be3-687c-47a3-893e-b7b6fd1caa93",
                    "triggerTime": 0
                  }
                ]
              },
              {
                "id": "L001-text",
                "type": "text",
                "mode": "lecture",
                "html": "<p>State Spaces, Vector Spaces and Trajectories</p>...",
                "nodes": []
              }
            ]
          }
        ]
      }
    ]
  },
  "error": null,
  "message": "操作成功"
}
```

### 5.3 字段说明

| 字段 | 说明 |
|---|---|
| `whatYouLearn` | 课程本地化 JSON，通常是字符串数组 |
| `provides` | 课程本地化 JSON，通常是 `{ type, title }[]` |
| `totalDurationSeconds` | 默认内容语言课时视频时长之和 |
| `trial` | `enabled` 来自课程；`lessonIds` 来自 `TrialSetting.status='READY'` |
| `plans` | 当前环境有效订阅计划；价格不属于版本快照 |
| `sections[].lessons[].isPublic` | 该课时是否在试看中开放 |
| `contents[].url` | Portal 媒体端点相对路径 |
| `contents[].nodes` | 展品 / 触发器节点 |

---

## 6. 媒体端点

### 6.1 封面

```http
GET /api/portal/v1/media/:courseId/cover
```

返回 `image/png`、`image/jpeg`、`image/webp` 等二进制。  
仅当课程 `ONLINE`、未归档且存在封面时返回 200，否则 404。

### 6.2 课程资产

```http
GET /api/portal/v1/media/:courseId/assets/:assetId
```

返回视频、图片、PDF 等媒体。服务端校验：

- 课程 `ONLINE` 且未归档
- `CourseMediaAsset.courseId === :courseId`
- 存储层文件存在

否则 404。

> 这两个端点的响应是二进制，不带 JSON 信封；Portal 可直接作为 `<img src>` / `<video src>` 使用。

---

## 7. 课程预览（草稿 / 指定版本，Admin 自建 Portal 风格页面）

### 7.1 目标

Admin 的「学员视角预览（草稿）」继续保留，用于内容 QA；  
「在 Portal 中预览」生成短时效签名链接，落到 **Admin 自建**的 Portal 风格课程预览页，
按 Portal 课程详情页的版式（封面 / 概览 / 你将学到什么 / 大纲 / 本课程提供 / 订阅计划）渲染草稿或指定版本。

该方案**不修改 Portal 仓库**、不要求 Portal 新增 `/preview` 路由，也不会把未发布内容暴露到公开站点：

```text
Back Office「在 Portal 中预览」
        │  GET /api/backoffice/courses/:id/portal-preview
        ▼
/{locale}/portal-preview/{courseId}?token=...   （Admin 站点，员工会话）
        │  GET /api/backoffice/courses/:id/portal-preview/content?token=...
        ▼
草稿 / 指定版本投影（与 Portal v1 投影同构） → 按 Portal 版式渲染
```

### 7.2 Admin 生成链接

```http
GET /api/backoffice/courses/:id/portal-preview?locale=zh-CN&versionId=<可选>
```

员工会话鉴权。`versionId` 为空表示当前草稿；传入表示指定版本快照。

成功响应：

```json
{
  "success": true,
  "data": {
    "url": "/zh-CN/portal-preview/4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2?token=eyJ2Ijox...",
    "token": "eyJ2Ijox...",
    "expiresAt": "2026-11-01T09:00:00.000Z",
    "source": "draft",
    "courseId": "4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2",
    "versionId": null
  },
  "error": null,
  "message": "操作成功"
}
```

配置：

| 环境变量 | 说明 |
|---|---|
| `PORTAL_PREVIEW_SECRET` | 预览 token 的 HMAC 签名密钥；部署环境必填 |
| `ADMIN_PORTAL_PREVIEW_PATH` | 可选；预览页路由模板，默认 `/{locale}/portal-preview/{courseId}?token={token}`，也可用 `{slug}` |
| `BACKOFFICE_APP_URL` | 可选；预览链接站点根。留空时返回相对路径，在当前 Admin origin 打开（推荐） |

本地未配置 `PORTAL_PREVIEW_SECRET` 时使用开发密钥；部署环境未配置会返回 `PORTAL_PREVIEW_NOT_CONFIGURED`。

### 7.3 Admin 预览页取数据

```http
GET /api/backoffice/courses/:id/portal-preview/content?token=<token>
```

员工会话 + 预览 token 双重要求：Admin 校验 token 签名、`aud`、过期时间，并要求 token 的 `courseId`
与路径参数一致（否则 401）。通过后返回草稿或指定版本的详情结构，并额外带：

```json
{
  "preview": {
    "source": "draft",
    "versionLabel": null
  }
}
```

> `/api/portal/v1/preview/course` 仍保留（服务鉴权 + token），供 Portal 未来实现自有预览路由时使用；
> Admin 预览页不依赖该端点。

### 7.4 Token 载荷

```json
{
  "v": 1,
  "aud": "portal-preview",
  "courseId": "4d22b6a5-c091-4fc1-90d5-1c16bf2cb1b2",
  "versionId": null,
  "slug": "modeling-life",
  "source": "draft",
  "iat": 1761987600,
  "exp": 1761988200
}
```

签名方式：

```text
token = base64url(JSON.stringify(payload)) + "." + base64url(HMAC-SHA256(secret, base64urlPayload))
```

服务端校验示例（Admin 预览页与 Portal 将来实现共用同一算法）：

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const [body, signature] = token.split('.');
const expected = createHmac('sha256', process.env.PORTAL_PREVIEW_SECRET!)
  .update(body)
  .digest('base64url');
const a = Buffer.from(signature);
const b = Buffer.from(expected);
if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('invalid token');

const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
if (payload.aud !== 'portal-preview' || payload.exp <= Date.now() / 1000) {
  throw new Error('expired token');
}
```

> 预览 token 只授权“看这一门课的草稿/版本”，不自带写权限；Admin 预览页还要求员工会话。

---

## 8. 剩余缺口 / 非目标

| 项 | 状态 | 说明 |
|---|---|---|
| 课程预览页 | 已实现（Admin 站点） | `/{locale}/portal-preview/{courseId}?token=...`，按 Portal 课程详情版式渲染草稿/版本；不修改 Portal 仓库 |
| Portal 自有预览路由 | 非目标 | 原方案的 `/{locale}/portal/courses/{slug}/preview` 需改 Portal 仓库，现由 Admin 自建预览页替代；`/api/portal/v1/preview/course` 仍保留备用 |
| 媒体绝对地址 | 约定 | 当前返回 Admin 相对路径；Portal 需拼接 Admin origin 或反向代理 |
| 按 `code` 查询 | 未实现 | 当前详情只接受内部 UUID；Portal 可用列表返回的 `id`，或后续新增 `by-code` 端点 |
| 多语言协商 | 未实现 | 当前固定默认内容语言；如需按 `Accept-Language` 返回，需要新增参数 |
| SEO / OG 元数据 | 非投影目标 | Portal 可用 `title` / `description` / `coverUrl` 自行生成 |
| 预览 token 撤销 | 未实现 | 当前仅靠短 TTL；如需强制撤销，可加版本号或黑名单 |
| 作者 / 关联课程等页面模块 | 非投影目标 | 如实际 Portal 页面新增模块，需要另开字段 |

---

## 9. OpenAPI 草案（3.1）

```yaml
openapi: 3.1.0
info:
  title: Learning Guide Admin - Portal Projection API
  version: 1.1.0
  description: Portal 课程列表、详情、媒体与草稿预览。
servers:
  - url: https://cpzmzuzkkj.ap-southeast-1.awsapprunner.com
    description: DEV
  - url: http://localhost:3001
    description: Local
security:
  - ApiKeyAuth: []
paths:
  /api/portal/v1/courses:
    get:
      summary: List online courses
      parameters:
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CourseListEnvelope'
  /api/portal/v1/courses/{id}:
    get:
      summary: Get online course detail
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CourseDetailEnvelope'
        '404':
          description: Course not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorEnvelope'
  /api/portal/v1/media/{courseId}/cover:
    get:
      summary: Get course cover binary
      parameters:
        - in: path
          name: courseId
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: Binary image
          content:
            image/*:
              schema: { type: string, format: binary }
        '404':
          description: Cover not found
  /api/portal/v1/media/{courseId}/assets/{assetId}:
    get:
      summary: Get course media asset binary
      parameters:
        - in: path
          name: courseId
          required: true
          schema: { type: string, format: uuid }
        - in: path
          name: assetId
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: Binary media
          content:
            application/octet-stream:
              schema: { type: string, format: binary }
        '404':
          description: Media not found
  /api/portal/v1/preview/course:
    get:
      summary: Get draft/version projection by signed preview token
      parameters:
        - in: query
          name: token
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CourseDetailEnvelope'
        '401':
          description: Invalid or expired preview token
        '404':
          description: Course or version not found
  /api/backoffice/courses/{id}/portal-preview:
    get:
      summary: Create short-lived Portal preview link
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string, format: uuid }
        - in: query
          name: versionId
          schema: { type: string, format: uuid }
        - in: query
          name: locale
          schema: { type: string, example: zh-CN }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PreviewLinkEnvelope'
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
  schemas:
    Envelope:
      type: object
      required: [success, data, error]
      properties:
        success: { type: boolean }
        data: {}
        error:
          oneOf:
            - { type: 'null' }
            - $ref: '#/components/schemas/ApiError'
    ApiError:
      type: object
      required: [code, message]
      properties:
        code: { type: string }
        message: { type: string }
    CourseListEnvelope:
      allOf:
        - $ref: '#/components/schemas/Envelope'
        - type: object
          properties:
            data:
              type: array
              items:
                $ref: '#/components/schemas/CourseSummary'
    CourseDetailEnvelope:
      allOf:
        - $ref: '#/components/schemas/Envelope'
        - type: object
          properties:
            data:
              $ref: '#/components/schemas/CourseDetail'
    ErrorEnvelope:
      allOf:
        - $ref: '#/components/schemas/Envelope'
        - type: object
          properties:
            success: { const: false }
            error:
              $ref: '#/components/schemas/ApiError'
    CourseSummary:
      type: object
      required:
        [id, slug, code, title, shortDescription, description, category,
         referencePrice, discount, coverUrl, lessonCount, totalDurationSeconds,
         learningMode, learningLanguages]
      properties:
        id: { type: string, format: uuid }
        slug: { type: string }
        code: { type: string }
        title: { type: string }
        subtitle: { type: [string, 'null'] }
        shortDescription: { type: [string, 'null'] }
        description: { type: [string, 'null'] }
        category: { type: [string, 'null'] }
        level: { type: [string, 'null'] }
        tags: { type: array, items: {} }
        referencePrice: { type: integer }
        discount: { type: integer }
        coverUrl: { type: [string, 'null'] }
        lessonCount: { type: integer }
        totalDurationSeconds: { type: integer }
        learningMode: { type: [string, 'null'] }
        learningLanguages: { type: array, items: { type: string } }
    CourseDetail:
      allOf:
        - $ref: '#/components/schemas/CourseSummary'
        - type: object
          required:
            [defaultContentLanguage, whatYouLearn, provides, trial, plans, sections]
          properties:
            defaultContentLanguage: { type: string }
            whatYouLearn: {}
            provides: {}
            trial:
              type: object
              required: [enabled, lessonIds]
              properties:
                enabled: { type: boolean }
                lessonIds: { type: array, items: { type: string, format: uuid } }
            plans:
              type: array
              items:
                $ref: '#/components/schemas/CoursePlan'
            sections:
              type: array
              items:
                $ref: '#/components/schemas/CourseSection'
            preview:
              type: object
              properties:
                source: { enum: [draft, version] }
                versionLabel: { type: [string, 'null'] }
    CoursePlan:
      type: object
      required: [id, name, termMonths, amountMinor, currency, lookupKey, trialEligible]
      properties:
        id: { type: string }
        name: { type: string }
        termMonths: { type: integer }
        amountMinor: { type: integer }
        currency: { type: string }
        lookupKey: { type: [string, 'null'] }
        trialEligible: { type: boolean }
    CourseSection:
      type: object
      required: [id, title, lessons]
      properties:
        id: { type: string }
        title: { type: string }
        lessons:
          type: array
          items:
            $ref: '#/components/schemas/CourseLesson'
    CourseLesson:
      type: object
      required: [id, title, summary, durationSeconds, isPublic, contents]
      properties:
        id: { type: string, format: uuid }
        title: { type: string }
        summary: { type: [string, 'null'] }
        durationSeconds: { type: [integer, 'null'] }
        isPublic: { type: boolean }
        contents:
          type: array
          items:
            $ref: '#/components/schemas/CourseContent'
    CourseContent:
      type: object
      required: [id, type, mode]
      properties:
        id: { type: string }
        title: { type: string }
        type: { enum: [video, text] }
        mode: { type: string }
        url: { type: string }
        html: { type: string }
        nodes:
          type: array
          items:
            $ref: '#/components/schemas/CourseContentNode'
    CourseContentNode:
      type: object
      required: [id, title, type, triggerTime]
      properties:
        id: { type: string }
        title: { type: string }
        type: { enum: [image, video, model3d] }
        url: { type: string }
        triggerTime: { type: number }
    PreviewLinkEnvelope:
      allOf:
        - $ref: '#/components/schemas/Envelope'
        - type: object
          properties:
            data:
              type: object
              required: [url, token, expiresAt, source, courseId, versionId]
              properties:
                url: { type: string, format: uri }
                token: { type: string }
                expiresAt: { type: string, format: date-time }
                source: { enum: [draft, version] }
                courseId: { type: string, format: uuid }
                versionId: { type: [string, 'null'], format: uuid }
```

---

## 10. 可执行验证

### 10.1 E2E 契约测试

```bash
cd server
npm run test:e2e -- --runInBand test/portal-projection.e2e-spec.ts
```

覆盖：

1. 列表只返回 `ONLINE`、未归档课程，并使用 live 快照文案
2. 详情返回补齐字段、课时时长、计划、试看、媒体 URL
3. 封面 / 媒体端点返回正确二进制，跨课程资产 404
4. 未发布课程详情 404
5. Admin 生成签名预览链接
6. 预览 token 可读取草稿 / 指定版本，篡改 token 401

### 10.2 手工验证

```bash
# 列表
curl -s "http://localhost:3001/api/portal/v1/courses?limit=10" | jq

# 详情
curl -s "http://localhost:3001/api/portal/v1/courses/<courseId>" | jq

# 封面
curl -I "http://localhost:3001/api/portal/v1/media/<courseId>/cover"

# 生成预览链接（需要员工会话 Cookie）
curl -s "http://localhost:3001/api/backoffice/courses/<courseId>/portal-preview?locale=zh-CN" | jq
```

---

## 11. 本地测试数据说明

为生成样例，本地 `C001`（Modeling life）已执行：

1. Publish → 生成 `Version 1.1`
2. Change status → `ONLINE`（reason: `publish for portal projection test`）

如需恢复本地状态，可在 Admin 课程详情页将其改回 `HIDDEN` / `OFFLINE`。
