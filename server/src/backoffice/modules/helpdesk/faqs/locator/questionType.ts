/**
 * 定位方式 B（设计文档「Helpdesk 定位方式对比」第四节第 1 步）：判断学员问的是流程（怎么做、做了不对）
 * 还是内容（是什么、多少、规则是什么）。不调模型，两个信号相加：
 * - 句式：「怎么」「收不到」偏流程，「多少」「多久」「能不能」偏内容；
 * - 检索：全库检索的前几张卡里流程卡（操作步骤、故障排查）占多少。
 * 两边分不出 = both：流程树和对象表都走，由后面的回退兜住判错。
 */

/** 卡的类型：操作步骤 / 故障排查 / 规则说明（helpdesk_faqs.card_type）。 */
export const CARD_TYPES = ['how_to', 'troubleshoot', 'rule'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export type QuestionType = 'process' | 'content' | 'both';

/** 偏流程的句式（简体、繁体、英文；英文按小写比）。 */
export const PROCESS_CUES: readonly string[] = [
  '怎么',
  '怎麼',
  '如何',
  '在哪',
  '哪里',
  '哪裡',
  '找不到',
  '点不了',
  '點不了',
  '收不到',
  '报错',
  '報錯',
  '出错',
  '出錯',
  '失败',
  '失敗',
  '进不去',
  '進不去',
  '打不开',
  '打不開',
  '登不上',
  '没反应',
  '沒反應',
  '卡住',
  '不显示',
  '不顯示',
  '无法',
  '無法',
  'how do i',
  'how to',
  'how can i',
  'where',
  "can't",
  'cannot',
  "won't",
  "doesn't",
  'not working',
  'error',
  'failed',
  'stuck',
  'unable',
];

/** 偏内容的句式。 */
export const CONTENT_CUES: readonly string[] = [
  '多少',
  '多久',
  '多长',
  '多長',
  '能不能',
  '可不可以',
  '是否',
  '有没有',
  '有沒有',
  '会不会',
  '會不會',
  '是什么',
  '是什麼',
  '什么是',
  '什麼是',
  '包括',
  '包含',
  '区别',
  '區別',
  'how much',
  'how long',
  'how many',
  'what is',
  "what's",
  'is there',
  'are there',
  'do i need',
  'difference',
];

const countCues = (text: string, cues: readonly string[]) =>
  cues.reduce((n, cue) => n + (text.includes(cue) ? 1 : 0), 0);

/**
 * 句式信号取 -1 / 0 / 1（只看哪边的句式多，不看多几个）；检索信号 = 2 × (流程卡占比 − 0.5)，落在 -1 到 1。
 * 两者相加，超过 margin 才定边。
 * 例：「试用结束会自动扣费吗」没有流程句式、有「会…」不算，前 10 里规则卡多 → content。
 */
export function questionType(
  text: string,
  topTypes: readonly CardType[],
  margin = 0.5,
): QuestionType {
  const lower = text.toLowerCase();
  const cue = Math.sign(
    countCues(lower, PROCESS_CUES) - countCues(lower, CONTENT_CUES),
  );
  const share = topTypes.length
    ? topTypes.filter((type) => type !== 'rule').length / topTypes.length
    : 0.5;
  const signal = cue + 2 * (share - 0.5);
  if (signal > margin) return 'process';
  if (signal < -margin) return 'content';
  return 'both';
}

/** 对象表的属性（设计文档 3.3）。 */
export const ATTRIBUTES = [
  'definition',
  'price',
  'timing',
  'limit',
  'eligibility',
  'visibility',
  'consequence',
] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

const ATTRIBUTE_CUES: Record<Attribute, readonly string[]> = {
  definition: [
    '是什么',
    '是什麼',
    '什么是',
    '什麼是',
    '包括',
    '包含',
    '区别',
    '區別',
    'what is',
    "what's",
    'include',
    'difference',
  ],
  price: [
    '多少钱',
    '多少錢',
    '价格',
    '價格',
    '费用',
    '費用',
    '收费',
    '收費',
    '扣费',
    '扣費',
    'price',
    'cost',
    'how much',
    'charge',
  ],
  timing: [
    '多久',
    '多长时间',
    '多長時間',
    '什么时候',
    '什麼時候',
    '何时',
    '何時',
    '期限',
    '到期',
    '过期',
    '過期',
    'how long',
    'when',
    'expire',
  ],
  limit: [
    '几个',
    '幾個',
    '多少人',
    '上限',
    '最多',
    '限制',
    '次数',
    '次數',
    'limit',
    'maximum',
    'how many',
  ],
  eligibility: [
    '能不能',
    '可不可以',
    '可以',
    '谁能',
    '誰能',
    '资格',
    '資格',
    '条件',
    '條件',
    'eligible',
    'who can',
    'can i',
  ],
  visibility: [
    '看到',
    '看得到',
    '可见',
    '可見',
    '公开',
    '公開',
    'visible',
    'see my',
    'who sees',
  ],
  consequence: [
    '会怎样',
    '會怎樣',
    '之后',
    '之後',
    '以后',
    '以後',
    '还能',
    '還能',
    '会不会',
    '會不會',
    'what happens',
    'after',
    'still',
  ],
};

/** 句子里出现的属性词 → 对象表里这些属性的格子加分（设计文档 4.3 第 3 步）。 */
export function attributeHints(text: string): Set<Attribute> {
  const lower = text.toLowerCase();
  return new Set(
    ATTRIBUTES.filter((attribute) =>
      ATTRIBUTE_CUES[attribute].some((cue) => lower.includes(cue)),
    ),
  );
}
