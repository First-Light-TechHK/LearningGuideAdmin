import {
  createNgramSimilarity,
  similarityFeatures,
} from '../modules/helpdesk/flywheel/textSimilarity';

/**
 * 缺口挖掘的「按意思分组」（v5 Part G3 第 2 步）：用现有检索的同一套文本归一（OpenCC 繁 → 简、
 * 港台用词与粤语 → 普通话、中文双字、英文词），IDF 加权的余弦相似度；接口留给以后的向量（embeddings）。
 */
describe('n-gram similarity (G3 grouping)', () => {
  const similarity = createNgramSimilarity();

  async function score(a: string, b: string, extra: string[] = []) {
    const [va, vb] = await similarity.embed([a, b, ...extra]);
    return similarity.similarity(va, vb);
  }

  // 同一批里的其它问题（IDF 按整批算，与夜间挖掘一样）
  const filler = [
    '怎么修改头像',
    '视频播放不了',
    '学习小组在哪里',
    '证书在哪里下载',
    '怎么取消订阅',
    '发票怎么开',
    '为什么扣了两次钱',
    '课程进度不见了',
    '邮箱收不到验证码',
    'how do I change my language',
    'where is my certificate',
    'cancel my subscription',
    'the video keeps buffering',
    'how do I join a study group',
    'can I get an invoice',
  ];

  it('features: simplified and Mandarin bigrams, English words without stop words, no placeholders', () => {
    expect(similarityFeatures('忘記密碼 <email>')).toEqual(
      expect.arrayContaining(['忘记', '记密', '密码']),
    );
    expect(similarityFeatures('忘記密碼 <email>')).not.toContain('email');
    expect(similarityFeatures('I forgot my password')).toEqual(
      expect.arrayContaining(['w:forgot', 'w:password']),
    );
    expect(similarityFeatures('I forgot my password')).not.toContain('w:my');
    expect(similarityFeatures('课程没有开通')).toEqual(
      expect.arrayContaining(['课程', '开通', 'c:课', 'c:通']),
    );
    expect(similarityFeatures('课程没有开通')).not.toContain('c:有');
    // 粤语口语也换成普通话的双字
    expect(similarityFeatures('點樣改密碼')).toEqual(
      expect.arrayContaining(['c:怎', '怎改', '密码']),
    );
  });

  it('Traditional and Simplified ways of asking the same thing are close', async () => {
    expect(
      await score('忘记密码怎么办', '忘記密碼怎麼辦', filler),
    ).toBeGreaterThan(0.9);
  });

  it('paraphrases that share the key words are close, unrelated questions are far', async () => {
    const close = await score(
      '付款成功了但是课程没有开通',
      '已经付款了课程还是没开通',
      filler,
    );
    const far = await score(
      '付款成功了但是课程没有开通',
      '怎么修改头像',
      filler,
    );
    expect(close).toBeGreaterThan(0.45);
    expect(far).toBeLessThan(0.15);
    const en = await score(
      'the password reset email never arrives',
      'reset password email not arriving',
      filler,
    );
    expect(en).toBeGreaterThan(0.45);
    expect(
      await score('reset password email', 'where is my certificate', filler),
    ).toBeLessThan(0.1);
  });

  it('is symmetric, 1 for the same text, 0 for an empty one', async () => {
    const [a, b, empty] = await similarity.embed([
      '退款要多久',
      '退款多久到账',
      '<phone>',
    ]);
    expect(similarity.similarity(a, b)).toBeCloseTo(
      similarity.similarity(b, a),
      10,
    );
    expect(similarity.similarity(a, a)).toBeCloseTo(1, 10);
    expect(similarity.similarity(a, empty)).toBe(0);
  });

  it('a group centroid is close to its members', async () => {
    const vectors = await similarity.embed([
      '课程没有开通',
      '付款后课程没开通',
      '买了课程没有开通',
      '怎么修改头像',
    ]);
    const centroid = similarity.centroid(vectors.slice(0, 3));
    expect(similarity.similarity(centroid, vectors[1])).toBeGreaterThan(0.6);
    expect(similarity.similarity(centroid, vectors[3])).toBeLessThan(0.1);
  });
});
