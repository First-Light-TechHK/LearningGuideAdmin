export function answerSections(answer: string): string[] {
  if (answer.length <= 2400) return [answer];
  const result: string[] = [];
  // 标记从原答复计算，避免扫描切片时把代码块的结束标志当作开始。
  const protectedSpans = [
    ...answer.matchAll(
      /\x60\x60\x60[\s\S]*?\x60\x60\x60|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$|!?\[[^\]\n]*\]\([^\s)]+\)/gu,
    ),
  ].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  let offset = 0;
  let rest = answer;
  while (rest.length > 2400) {
    const window = rest.slice(0, 2400);
    const boundary = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('. '),
    );
    let cut = boundary > 1000 ? boundary + 1 : window.length;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    const span = protectedSpans.find(
      ({ start, end }) => start < offset + cut && end > offset + cut,
    );
    if (span && span.end - span.start <= 3200)
      cut = span.start > offset ? span.start - offset : span.end - offset;
    result.push(rest.slice(0, cut));
    offset += cut;
    rest = rest.slice(cut);
  }
  if (rest) result.push(rest);
  return result;
}
