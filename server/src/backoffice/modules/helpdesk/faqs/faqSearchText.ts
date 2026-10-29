import * as openccT2cn from 'opencc-js/t2cn';

/**
 * 候选检索用的中文文本归一（只用在检索上，永远不改给学员看的文字）。
 *
 * FAQ 的中文是简体；学员也会用繁体（台湾 / 香港）和粤语口语写。双字重叠只认简体，所以先做：
 * 1. 繁体 → 简体：OpenCC（opencc-js，字级 + 港 / 台异体字；不用台湾词组表，它会把「登出」
 *    换成「注销」、「離線」换成「脱机」，在我们的业务里意思全错）；
 * 2. 港台常用词 → 大陆用词（电邮 → 邮箱、户口 → 账号、影片 → 视频 …）；
 * 3. 粤语口语 → 普通话（唔 → 不、咗 → 了、点样 → 怎么、睇 → 看 …）。
 * 2 和 3 是扩展，不是替换：检索同时用简体原句和改写后的句子（多出来的双字只会多命中，不会少命中）。
 * 表里只放语言 / 地区差异，不放业务同义词（投诉 ≈ 客服 之类由运营写进 FAQ 关键词）。
 */

type Convert = (text: string) => string;

/**
 * opencc-js 1.4.2 自带的类型声明在本项目的 nodenext 解析下读不全（types/full.d.ts 用不带扩展名的
 * ESM 相对导入），这里只声明用到的那一个函数。
 */
const { Converter } = openccT2cn as unknown as {
  Converter: (options: { from: string; to: string }) => Convert;
};

let simplify: Convert | null = null;

/** 繁体（港 / 台）→ 简体；首次调用时才加载 OpenCC 词典。 */
export function toSimplified(text: string): string {
  if (!simplify) {
    const fromHongKong = Converter({ from: 'hk', to: 'cn' });
    const fromTaiwan = Converter({ from: 'tw', to: 'cn' });
    simplify = (value) => fromTaiwan(fromHongKong(value));
  }
  return simplify(text);
}

/**
 * 港台用词与粤语口语 → 大陆普通话（键是 OpenCC 转换后的简体写法）。长的先匹配，
 * 所以「点击」（本身就是普通话）不会被「点 → 怎么」改坏，「唔记得」先于「唔」。
 */
export const MANDARIN_VARIANTS: Readonly<Record<string, string>> = {
  // 港台用词
  电邮: '邮箱 邮件',
  电子邮件: '邮箱 邮件',
  信箱: '邮箱',
  帐号: '账号',
  帐户: '账号',
  户口: '账号',
  开户口: '注册账号',
  登记: '注册',
  登入: '登录',
  登出: '退出登录',
  重设: '重置',
  设定: '设置',
  启用: '激活',
  验证信: '验证邮件',
  连结: '链接',
  影片: '视频',
  视像: '视频',
  视讯: '视频',
  载入: '加载',
  网页: '网站',
  网路: '网络',
  软体: '软件',
  程式: '程序',
  讯息: '信息',
  资讯: '信息',
  支援: '支持',
  透过: '通过',
  列印: '打印',
  手提电话: '手机',
  信用咭: '信用卡',
  摄影机: '摄像头',
  镜头: '摄像头',
  咪高峰: '麦克风',
  头相: '头像',
  单据: '收据',
  收条: '收据',
  计划: '方案',
  价钱: '价格',
  几钱: '多少钱',
  几多钱: '多少钱',
  联络: '联系',
  证明书: '证书',
  续期: '续订',
  课堂: '课程',
  试睇: '试看',
  // 粤语口语
  唔该: '请',
  唔记得: '忘记',
  唔到: '不了',
  可唔可以: '可以',
  得唔得: '可以吗',
  开唔到: '打不开',
  唔: '不',
  咗: '了',
  嘅: '的',
  啲: '些',
  嘢: '东西',
  乜嘢: '什么',
  乜: '什么',
  咩: '什么',
  点击: '点击',
  点样: '怎么',
  点解: '为什么',
  点算: '怎么办',
  点: '怎么',
  揾: '找',
  冇: '没有',
  系咪: '是不是',
  系: '是',
  喺: '在',
  俾钱: '付钱',
  畀钱: '付钱',
  俾: '给',
  畀: '给',
  攞: '拿',
  嚟: '来',
  佢哋: '他们',
  你哋: '你们',
  我哋: '我们',
  佢: '他',
  哋: '们',
  而家: '现在',
  依家: '现在',
  边度: '哪里',
  边个: '谁',
  边: '哪',
  几多: '多少',
  咁: '这么',
  嗰: '那',
  '𠮶': '那',
  呢个: '这个',
  呢度: '这里',
  仲: '还',
  返: '回',
  睇: '看',
  郁: '动',
  识: '会',
  啱啱: '刚刚',
  啱: '对',
  拣: '选',
  搞掂: '搞定',
};

const VARIANT_PATTERN = new RegExp(
  Object.keys(MANDARIN_VARIANTS)
    .sort((a, b) => [...b].length - [...a].length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gu',
);

/** 简体文本里的港台用词与粤语口语改写成普通话（表见 MANDARIN_VARIANTS）。 */
export function toMandarin(simplified: string): string {
  return simplified.replace(
    VARIANT_PATTERN,
    (match) => MANDARIN_VARIANTS[match] ?? match,
  );
}

const HAN = /\p{Script=Han}/u;

/**
 * 检索用的中文写法：简体原句，以及（有变化时）普通话改写，去重、保持顺序。
 * 不含汉字的文本原样返回一项。
 */
export function chineseSearchForms(text: string): string[] {
  if (!HAN.test(text)) return [text];
  const simplified = toSimplified(text);
  return [...new Set([simplified, toMandarin(simplified)])];
}

/** 拼写容错只看这么长以上的词（再短的词删一个字母后太容易撞上别的词）。 */
export const TYPO_MIN_LENGTH = 5;

/**
 * 英文拼写容错的查询键（对称删除，与迁移 20261029150000_helpdesk_faqs_typo_keys 的
 * helpdesk_faq_typo_keys 是同一规则）：≥5 个字母的词给出它自己和每个「删掉一个字母」的写法；
 * 4 个字母的词只给它自己（能对上 FAQ 里 5 个字母的词删掉一个字母，如 plns ↔ plans）。
 * keys[i] 来自第 word[i] 个词，打分时按词计数（一个词只算一次）。
 */
export function typoKeys(words: readonly string[]): {
  keys: string[];
  word: number[];
} {
  const keys: string[] = [];
  const word: number[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const raw of new Set(words)) {
    if (!/^[a-z]+$/.test(raw) || raw.length < TYPO_MIN_LENGTH - 1) continue;
    const variants = new Set([raw]);
    if (raw.length >= TYPO_MIN_LENGTH)
      for (let i = 0; i < raw.length; i++)
        variants.add(raw.slice(0, i) + raw.slice(i + 1));
    for (const key of variants) {
      const pair = `${index}:${key}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      keys.push(key);
      word.push(index);
    }
    index += 1;
  }
  return { keys, word };
}
