import { JackLectureOutput } from './jack-lecture-output';
import { jackLectureImage } from './jack-lecture-images';

const course = 'course-a';
const file = (n: number) =>
  '/api/files/images/' +
  course +
  '/00000000-0000-4000-8000-' +
  String(n).padStart(12, '0') +
  '.png';
const body = [
  'Exhibit 1.6 一维状态点',
  '![' +
    '一维状态点 · State points — X moves from 4 to 6.' +
    '](' +
    file(6) +
    ')',
  'Exhibit 1.6 X = 4 then X = 6.',
  'Exhibit 1.8 三维状态向量',
  '![三维状态向量 · Three-dimensional state vector — S, T and P axes.](' +
    file(8) +
    ')',
].join('\n\n');
const pages = [{ title: 'Lesson 1', contentMd: body }];

describe('Jack Lecture 的配图', () => {
  it.each([
    '只用文字解释三维状态向量',
    'Explain the three-dimensional state vector without examples or a diagram.',
  ])('禁图：%s', (q) => {
    expect(
      jackLectureImage(q, course, pages, JSON.stringify({ evidence: body }))
        .image,
    ).toBeUndefined();
  });
  it.each([
    ['请展示图 1.6', 6],
    ['Show the lesson figure with axes S, T and P.', 8],
  ] as const)('指定图可从同版快照补查：%s', (q, n) => {
    expect(jackLectureImage(q, course, pages, '').image?.url).toBe(file(n));
    expect(
      jackLectureImage(q, 'other-course', pages, '').image,
    ).toBeUndefined();
  });
  it('指定图缺失及无关例题均不配替代图', () => {
    expect(
      jackLectureImage('Show Exhibit 1.60', course, pages, '').image,
    ).toBeUndefined();
    expect(
      jackLectureImage(
        'A car makes a round trip. Was it moving?',
        course,
        pages,
        JSON.stringify({ evidence: body }),
      ).image,
    ).toBeUndefined();
  });
});

describe('Jack Lecture 的流式 Markdown', () => {
  it('逐字与一次性交付一致，保留正常 Markdown、代码、引用和矩阵行', () => {
    const code = '```txt\n![example](url) and $$\n```';
    const raw = [
      '正文 ![bad [nested]](a(b))![duplicate][figure]',
      code,
      '金额 $5。',
      '$$\\begin{cases}',
      'x \\\\',
      'y',
      '\\end{cases}$$ [1]',
      '第三行是钾离子。',
    ].join('\n');
    const all = new JackLectureOutput().push(raw, true);
    expect(all).toContain(code);
    expect(all).not.toContain('duplicate');
    expect(all).not.toContain('a(b)');
    expect(all).toContain(
      '$$\n\\begin{cases}\nx \\\\\ny\n\\end{cases}\n$$\n [1]',
    );
    const run = new JackLectureOutput();
    const streamed =
      [...raw].map((c) => run.push(c)).join('') + run.push('', true);
    expect(streamed).toBe(all);
  });

  it('未闭合的多行公式与图片不会先进入已显示的正文', () => {
    const run = new JackLectureOutput();
    expect(run.push('Before\n$$\\begin{pmatrix}\nx')).toBe('Before\n');
    expect(run.push('\n\\end{pmatrix}$$ [1] ![bad](')).toContain(
      '\\end{pmatrix}\n$$\n',
    );
    expect(run.push('url) after', true)).toBe(' after');
  });
  it('过滤被拆分的 HTML 图片，并保留正文中的不等号', () => {
    const run = new JackLectureOutput();
    const raw = 'x < 4. <img src="wrong" alt="a > b" /> Done.';
    expect([...raw].map((c) => run.push(c)).join('') + run.push('', true)).toBe(
      'x < 4.  Done.',
    );
  });
});
