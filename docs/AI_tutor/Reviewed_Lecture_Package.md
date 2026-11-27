# Lecture 教学包发布与试跑

在 Backoffice 的 Knowledge → 教学条目选择课程并编辑内容。单条保存和批量导入都会将当前修订纳入下一次发布。再到 Releases 创建版本，服务端对照课程正文校验证据及图式，并记录纳入的修订和保存人。上传现成教学包的 JSON 入口也可用于导入旧数据。留空时会继承相应的导入内容并合并本课程可随版本发布的条目。

- 浏览来源页面后，将教材原文摘录加到教学条目。Wiki 编辑器可搜索并插入当前课程已保存的图式，教学条目可在回答正文预览与插入图片或公式。
- “备课草稿”支持选择当前编辑页面或已发布页面作为来源、生成或粘贴母版增量输出、查看前后内容，再应用勾选的更新。目标页在预览后变化时，服务端会提示重新核对。
- 上游同步字段为 `CourseID`。Yong 从当轮输入和明确追问的历史判断课程主题。规则无法确定时，可以在本课程批准主题中做结构化匹配。唯一精确命中时直接选用教授卡，生成阶段根据学生提问组织答案。

下面的示例用于测试。先在课程的一页正文中保存一次 `向量是向量空间的元素。`，再提交这个教学包。证据摘录须与快照中一处原文精确对应。

```json
{
  "glossary": [
    {
      "conceptId": "vector",
      "label": { "en": "vector", "zh": "向量" },
      "aliases": { "en": ["vector space"], "zh": ["向量空间"] }
    }
  ],
  "cards": [
    {
      "cardId": "vector-explain",
      "conceptId": "vector",
      "topic": "*",
      "type": "teaching_move",
      "canonicalPoint": "Explain the course definition.",
      "approvedPayload": { "instruction": "先说明定义，再回答学生的具体疑问。" },
      "bilingual": {
        "conceptLabel": { "en": "vector", "zh": "向量" },
        "summary": { "en": "Explain the definition.", "zh": "解释定义。" },
        "triggers": { "en": [], "zh": [] }
      },
      "useWhen": ["*"],
      "doNotUseWhen": [],
      "evidence": ["向量是向量空间的元素。"],
      "links": [],
      "priority": 1,
      "reviewerId": "reviewer"
    },
    {
      "cardId": "vector-definition",
      "conceptId": "vector",
      "topic": "vectors",
      "type": "concept",
      "canonicalPoint": "向量是向量空间的元素。",
      "approvedPayload": { "explanation": "向量可以是有序数组，也可以是满足相应性质的函数。" },
      "bilingual": {
        "conceptLabel": { "en": "vector", "zh": "向量" },
        "summary": { "en": "An element of a vector space.", "zh": "向量空间的元素。" },
        "triggers": { "en": ["vector"], "zh": ["向量"] }
      },
      "useWhen": ["*"],
      "doNotUseWhen": [],
      "evidence": ["向量是向量空间的元素。"],
      "links": [],
      "priority": 1,
      "reviewerId": "reviewer"
    },
    {
      "cardId": "qa-define-vector",
      "conceptId": "vector",
      "topic": "vectors",
      "type": "professor_qa",
      "canonicalPoint": "向量是向量空间的元素。",
      "approvedPayload": {
        "question": "什么是向量？",
        "answerMd": "向量是向量空间的元素。[记号](refobj:vector-notation)",
        "refObjects": [
          {
            "id": "vector-notation",
            "kind": "latex",
            "label": "向量记号",
            "value": "v\\in V",
            "requires": []
          }
        ]
      },
      "bilingual": {
        "conceptLabel": { "en": "vector", "zh": "向量" },
        "summary": { "en": "An element of a vector space.", "zh": "向量空间的元素。" },
        "triggers": { "en": [], "zh": ["什么是向量"] }
      },
      "useWhen": ["*"],
      "doNotUseWhen": [],
      "evidence": ["向量是向量空间的元素。"],
      "links": [],
      "priority": 1,
      "reviewerId": "reviewer"
    }
  ]
}
```

- `topic: "*"` 表示课程范围的教学规则。Yong 在当前课程 Release 内根据问题匹配主题，无需同步课节 ID。
- `useWhen` 取 `factual_recall`、`concept_framework`、`interpretive_application` 或 `*`。`doNotUseWhen` 接受类别或排除短语。`links` 使用同一教学包中的 `cardId`，数值越小的 `priority` 越优先。
- `bilingual.triggers` 中的教授 QA 问法按语言精确匹配，只忽略首尾空白、末尾问号等标点、大小写和全半角差异。完整覆盖时采用教授答案及条件，部分覆盖时采用可定位的原文片段，其余部分依据课程材料。
- 图式使用同条卡的 `approvedPayload.refObjects` 声明。图片类型为 `image`，`value` 是已上传的本课程图片文件名及扩展名。公式类型为 `latex`，`value` 是不含美元分隔符的 LaTeX。可以在批准答案或证据原文中插入 `[标题](refobj:对象ID)`，再用 `requires` 写明例题必须匹配的短语或数值。
- 发布后先在 AI Tutor 选中测试 Release，用 Lecture 分别问“什么是向量？”和“向量空间里的向量有什么特征？”。前者应采用原文，后者应按课程证据解释。知识开关关闭的线路用于对照。测试后按现有 Set Live 操作激活，切回旧 Release 可以恢复旧教学内容。
- 运行日志通过 `requestId` 核对 `teaching` 中的包哈希、主题、任务类型、所选 QA、教学卡、证据和输出对象。教授原文分支不需要调用模型。

## 本地上线前验证

在服务端目录运行 Prisma 迁移，并把下面的测试指向一个**隔离的本地 PostgreSQL 数据库**。数据库名称必须是 `tutor_preflight`。测试会创建试点课程、页面、条目和 Release。

```powershell
$env:DATABASE_URL = 'postgresql://tutor_test@127.0.0.1:55436/tutor_preflight?schema=public'
node node_modules/prisma/build/index.js migrate deploy
$env:TUTOR_TEACHING_PG_TEST = '1'
npm run test:e2e -- --runInBand --runTestsByPath test/tutor-lecture-preflight.e2e-spec.ts
```

回放数据来自问题表中处于 Open 状态的 11 条 Lecture 记录。八条专家建议只在测试库中作为测试输入使用。测试验证按课程隔离、原文命中、近似问题的课程证据、错图排除、正确公式位置、保存并发冲突、上线版本隔离和回退。生成分支使用本地模型替身。
