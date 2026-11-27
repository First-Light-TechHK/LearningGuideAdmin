import {
  createLectureReferenceStream,
  readLectureReferences,
  type LectureReference,
} from './lecture-references';
import { previousExhibitIds } from './lecture-exhibits';

describe('mixed exhibit and source citations', () => {
  const id = 'bcf873fb-7cee-43d3-9656-791097a9cd6c';
  const image: LectureReference = {
    id,
    kind: 'image',
    code: 'Exhibit 1.2',
    label: '咖啡杯',
    value: '11111111-1111-4111-8111-111111111111.png',
    requires: [],
  };
  it('keeps source numbers across chunk boundaries and displays the approved exhibit once', () => {
    const text = `属性[[ref:${id}]]。温度 [1, [ref:${id}]]。重量 [ref:${id}]。体积 [2，ref:unknown，3]。`;
    for (const chunks of [
      [text],
      [...text],
      [text.slice(0, 20), text.slice(20)],
    ]) {
      const stream = createLectureReferenceStream(
        [image],
        'course',
        undefined,
        false,
        'release',
      );
      const prose = chunks.map((chunk) => stream.write(chunk)).join('');
      expect(prose).toBe('属性。温度 [1]。重量 。体积 [2, 3]。');
      const answer = prose + stream.finish([], prose);
      expect(answer.split('![咖啡杯]')).toHaveLength(2);
      expect(
        previousExhibitIds([{ role: 'assistant', content: answer }], 'release'),
      ).toEqual([id]);
      expect([...stream.objectIds]).toEqual([id]);
    }
  });

  it('places the figure after sentence punctuation and before the next paragraph', () => {
    const stream = createLectureReferenceStream(
      [image],
      'course',
      undefined,
      false,
      'release',
    );
    const text = `一杯咖啡[[ref:${id}]]。\n\n接着讨论温度 [1, [ref:${id}]]。`;
    const result =
      [...text].map((char) => stream.write(char)).join('') + stream.finish();
    expect(result).toMatch(
      /一杯咖啡。\s+咖啡杯\s+!\[咖啡杯\][\s\S]*接着讨论温度 \[1\]。/,
    );
    expect(result.split('![咖啡杯]')).toHaveLength(2);
  });

  it('uses the adjacent full caption once, across stream chunks and at completion', () => {
    const label = 'Exhibit 1.2 · 咖啡杯的状态变量 · Coffee state variables';
    const coffee = { ...image, label };
    for (const text of [
      label + ' [[ref:' + id + ']]',
      label + '\n\n[[ref:' + id + ']]\n下一段',
      label,
      '如 Exhibit 1.2 所示，温度随时间变化。\n[[ref:' + id + ']]',
      '此前介绍了 ' + label + '\n[[ref:' + id + ']]\n下一段',
    ]) {
      for (const chunks of [[text], [...text]]) {
        const stream = createLectureReferenceStream(
          [coffee],
          'course',
          undefined,
          true,
          'release',
        );
        const prose = chunks.map((chunk) => stream.write(chunk)).join('');
        const result = prose + stream.finish([], prose);
        expect(
          result.split('\n').filter((line) => line.trim() === label),
        ).toHaveLength(1);
        expect(result.split('![' + label + ']')).toHaveLength(2);
        expect(
          previousExhibitIds(
            [{ role: 'assistant', content: result }],
            'release',
          ),
        ).toEqual([id]);
        if (!text.startsWith(label))
          expect(result).toContain(text.split('\n')[0]);
      }
    }
  });

  it('keeps the subject complement when a streamed marker names the exhibit', () => {
    const text = 'The figure is [[ref:' + id + ']].\nNext.';
    const stream = createLectureReferenceStream(
      [image],
      'course',
      undefined,
      false,
      'release',
    );
    const result =
      [...text].map((c) => stream.write(c)).join('') + stream.finish();
    expect(result).toContain('The figure is Exhibit 1.2.');
    expect(result.split('![咖啡杯]')).toHaveLength(2);
  });

  it('recovers legacy row separators only within time-dependent matrices', () => {
    const value = [
      'x(t)=\\begin{bmatrix}',
      'S(t) \\',
      'T(t) \\\\',
      'P(t)',
      '\\end{bmatrix}',
    ].join('\n');
    const ref = { ...image, kind: 'latex' as const, value };
    const [normalized] = readLectureReferences({ refObjects: [ref] });
    expect(normalized.value).toBe(value.replace('S(t) \\', 'S(t) \\\\'));
    expect(readLectureReferences({ refObjects: [normalized] })).toEqual([
      normalized,
    ]);
  });

  it('retains the identity of the matching calculation without appending a second worked norm', () => {
    const ref = {
      ...image,
      kind: 'latex' as const,
      code: 'Norm',
      label: 'Norm',
      value: String.raw`|v|=\sqrt{(-1.5)^2+4^2}`,
    };
    const tail = (answer: string) =>
      createLectureReferenceStream([ref], 'c', undefined, true, 'r').finish(
        [],
        answer,
      );
    expect(tail(String.raw`$$\sqrt{4^2+(-1.5)^2}$$`)).toContain(
      'Norm\n\n[exhibit:r:',
    );
    expect(tail(String.raw`$$\sqrt{4^2+(-1.5)^2}$$`)).not.toContain('$$');
    expect(tail(String.raw`$$\sqrt{3^2+4^2}$$`)).toContain('$$');
  });

  it('keeps ordinary Markdown, formulas and permitted Wiki images intact across chunks', () => {
    const stream = createLectureReferenceStream(
      [],
      'course',
      undefined,
      false,
      'release',
    );
    const md =
      '范围 $[0, 1]$。 [1, 2] [参考](https://example.com) ![图](/api/test) [末尾]';
    expect(
      [...md].map((char) => stream.write(char, true)).join('') +
        stream.finish(),
    ).toBe(md);
  });

  it('emits multiline LaTeX with separate fences and keeps the formula identity for follow-ups', () => {
    const matrix = {
      ...image,
      kind: 'latex' as const,
      code: 'L3-F02',
      label: '三维状态向量',
      value: String.raw`x(t) = \begin{bmatrix}
S(t) \\
T(t) \\
P(t)
\end{bmatrix}`,
    };
    const stream = createLectureReferenceStream(
      [matrix],
      'course',
      undefined,
      true,
      'release',
    );
    const answer = stream.finish();
    expect(answer).toContain(
      `$$\n${matrix.value}\n$$\n\n[exhibit:release:${id}]: #formula`,
    );
    expect(
      previousExhibitIds([{ role: 'assistant', content: answer }], 'release'),
    ).toEqual([id]);
  });
});
