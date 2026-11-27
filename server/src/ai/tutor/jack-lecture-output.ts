/** Jack owns image placement. Hold unfinished Markdown tokens across provider deltas. */
export class JackLectureOutput {
  private pending = '';

  push(delta: string, final = false): string {
    this.pending += delta;
    const text = this.pending;
    let result = '';
    let i = 0;
    const special = /[!<$]|`+|~+/g;
    while (i < text.length) {
      special.lastIndex = i;
      const match = special.exec(text);
      if (!match) {
        result += text.slice(i);
        i = text.length;
        break;
      }
      result += text.slice(i, match.index);
      i = match.index;
      const token = match[0];
      if (i + token.length === text.length && !final) break;
      if (token === '<') {
        const tail = text.slice(i);
        if (!final && '<img'.startsWith(tail.toLowerCase())) break;
        if (/^<img(?=[\s/>])/i.test(tail)) {
          const tag = /^<img(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(tail);
          if (!tag && !final) break;
          i += tag?.[0].length ?? tail.length;
          continue;
        }
      }
      if (token === '!' && text[i + 1] === '[') {
        const labelEnd = bracketEnd(text, i + 1, '[', ']');
        if (labelEnd === -1 || (labelEnd === text.length && !final)) {
          if (final) {
            result += '\\' + text.slice(i);
            i = text.length;
          }
          break;
        }
        const open = text[labelEnd];
        if (open === '(' || open === '[') {
          const end = bracketEnd(
            text,
            labelEnd,
            open,
            open === '(' ? ')' : ']',
          );
          if (end === -1 && !final) break;
          i = end === -1 ? text.length : end;
        } else i = labelEnd;
        continue;
      }
      if (token === '$' && text[i + 1] === '$' && text[i - 1] !== '\\') {
        const close = text.indexOf('$$', i + 2);
        if (close < 0 && !final) break;
        if (close < 0) {
          result += text.slice(i);
          i = text.length;
          break;
        }
        const body = text.slice(i + 2, close);
        result += body.includes('\n')
          ? '\n$$\n' + body.trim() + '\n$$\n'
          : text.slice(i, close + 2);
        i = close + 2;
        continue;
      }
      if (token.startsWith('`') || token.length >= 3) {
        const close = text.indexOf(token, i + token.length);
        if (close === -1 && !final) break;
        const end = close === -1 ? text.length : close + token.length;
        result += text.slice(i, end);
        i = end;
        continue;
      }
      result += token;
      i += token.length;
    }
    this.pending = text.slice(i);
    return result;
  }
}

// Markdown labels can contain escaped or nested brackets; asset URLs may contain parentheses.
function bracketEnd(text: string, start: number, open: string, close: string) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}
