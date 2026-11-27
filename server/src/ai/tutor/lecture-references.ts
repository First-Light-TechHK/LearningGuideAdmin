import type { LectureReference } from '../../ks/contract/teaching-references';
export {
  readLectureReferences,
  type LectureReference,
} from '../../ks/contract/teaching-references';

function imageUrl(
  object: LectureReference,
  courseId: string,
  externalCourseId?: string,
) {
  const base = externalCourseId
    ? `/api/user/courses/${encodeURIComponent(externalCourseId)}/images/`
    : `/api/files/images/${encodeURIComponent(courseId)}/`;
  return base + object.value;
}

export function lectureReferenceMarkdown(
  object: LectureReference,
  courseId: string,
  externalCourseId?: string,
  releaseId?: string,
  precedingText = '',
) {
  let caption = object.code ? object.label + '\n\n' : '';
  if (caption && object.kind === 'image' && precedingText) {
    const before = precedingText.trimEnd();
    const lastLine = before.slice(before.lastIndexOf('\n') + 1).trim();
    if (lastLine === object.label)
      caption = precedingText.endsWith('\n') ? '' : '\n\n';
  }
  if (object.kind === 'latex') {
    const block = object.value.includes('\n')
      ? `$$\n${object.value}\n$$`
      : `$$${object.value}$$`;
    return caption + block + formulaIdentity(object, releaseId);
  }
  const url = imageUrl(object, courseId, externalCourseId);
  if (releaseId) {
    const key = `exhibit:${releaseId}:${object.id}`;
    return caption + `![${object.label}][${key}]\n\n[${key}]: ${url}\n\n`;
  }
  return caption + `![${object.label}](${url})`;
}

function formulaIdentity(ref: LectureReference, releaseId?: string) {
  return releaseId && ref.code
    ? `\n\n[exhibit:${releaseId}:${ref.id}]: #formula\n\n`
    : '';
}

function containsFormula(answer: string, latex: string) {
  const compact = (value: string) => value.replace(/\s+/g, '');
  const source = compact(latex);
  const matrix =
    /^(?:[a-zA-Z]\(t\)=)?(\\begin\{[bp]?matrix\}[^&=]+?\\end\{[bp]?matrix\})$/;
  const matrixBody = (value: string) =>
    matrix.exec(value)?.[1].replace(/\{[bp]?matrix\}/g, '{matrix}');
  const squares = (value: string) =>
    /\\sqrt\{(\(?-?\d+(?:\.\d+)?\)?\^2)\+(\(?-?\d+(?:\.\d+)?\)?\^2)\}/
      .exec(value)
      ?.slice(1)
      .sort()
      .join('+');
  const sourceMatrix = matrixBody(source);
  const sourceSquares = /^\|[^=]+\|=\\sqrt\{[^}]+\}(?:\\approx[\d.]+)?$/.test(
    source,
  )
    ? squares(source)
    : undefined;
  return [
    ...answer.matchAll(
      /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\((.+?)\\\)|\$([^$\n]+)\$/g,
    ),
  ].some((match) => {
    const body = compact(match.slice(1).find(Boolean) ?? '');
    return (
      body === source ||
      (!!sourceMatrix &&
        !body.includes('=') &&
        matrixBody(body) === sourceMatrix) ||
      (!!sourceSquares && squares(body) === sourceSquares)
    );
  });
}

export function createLectureReferenceStream(
  references: LectureReference[],
  courseId: string,
  externalCourseId?: string,
  appendUnused = true,
  releaseId?: string,
) {
  const objects = new Map(
    references.map((reference) => [reference.id, reference]),
  );
  const objectIds = new Set<string>();
  const requestedObjects = new Map<string, LectureReference>();
  // Models sometimes put an exhibit marker in the same brackets as numbered sources.
  const id = '[a-z0-9-]{1,80}';
  const marker = `(?:\\[\\[ref:${id}\\]\\]|\\[ref:${id}\\]|ref:${id})`;
  const token = `(?:S?\\d+|${marker})`;
  const citation = new RegExp(
    `^\\[[ \\t]*(${token}(?:[ \\t]*[,，][ \\t]*${token})*)[ \\t]*\\]`,
    'i',
  );
  const partial = new RegExp(
    `^\\[[ \\t]*(?:${token}[ \\t]*[,，][ \\t]*)*(?:S?\\d*[ \\t]*|\\[{0,2}(?:r|re|ref(?::[a-z0-9-]{0,80}\\]{0,2})?)?)$`,
    'i',
  );
  let pending = '';
  let pendingBang = false;
  let proseTail = '';
  let previousOutput = '';
  // An inline marker can come before the sentence punctuation. Place its image after the line.
  function writeProse(text: string, chunkOutput: string) {
    if (text) proseTail = (proseTail + text.slice(-16)).slice(-16);
    const newline = text.indexOf('\n');
    if (newline < 0 || !requestedObjects.size) return text;
    const images = [...requestedObjects.values()].filter(
      (ref) => ref.kind === 'image',
    );
    if (!images.length) return text;
    for (const image of images) {
      objectIds.add(image.id);
      requestedObjects.delete(image.id);
    }
    const figures = images.map((ref, index) =>
      lectureReferenceMarkdown(
        ref,
        courseId,
        externalCourseId,
        releaseId,
        index === 0
          ? previousOutput + chunkOutput + text.slice(0, newline) + '\n\n'
          : '',
      ),
    );
    return (
      text.slice(0, newline) +
      '\n\n' +
      figures.join('\n\n') +
      text.slice(newline)
    );
  }
  return {
    objectIds,
    write(chunk: string, preserveImages = false) {
      const raw = (pendingBang ? '!' : '') + chunk;
      pendingBang = raw.endsWith('!');
      // Only the server can render an image for a reviewed answer.
      const text = pendingBang ? raw.slice(0, -1) : raw;
      let input =
        pending + (preserveImages ? text : text.replaceAll('![', '['));
      pending = '';
      let output = '';
      while (input) {
        const start = input.indexOf('[');
        if (start < 0) {
          output += writeProse(input, output);
          break;
        }
        output += writeProse(input.slice(0, start), output);
        input = input.slice(start);
        const match = citation.exec(input);
        if (!match) {
          if (input.length <= 512 && partial.test(input)) {
            pending = input;
            return output;
          }
          output += '[';
          input = input.slice(1);
          continue;
        }
        if (!/ref:/i.test(match[1])) output += match[0];
        else {
          const numbers = match[1]
            .split(/[,，]/)
            .map((value) => value.trim())
            .filter((value) => /^S?\d+$/i.test(value));
          if (numbers.length) output += '[' + numbers.join(', ') + ']';
          for (const ref of match[1].matchAll(/ref:([a-z0-9-]+)/gi)) {
            const object = objects.get(ref[1]);
            if (
              !numbers.length &&
              object?.kind === 'image' &&
              object.code &&
              releaseId &&
              /(?:\bis[ \t]+|是[ \t]*)$/i.test(proseTail)
            ) {
              output += object.code;
              proseTail = '';
            }
            if (!object || objectIds.has(object.id)) continue;
            if (object.code && releaseId)
              requestedObjects.set(object.id, object);
            else {
              objectIds.add(object.id);
              output += lectureReferenceMarkdown(
                object,
                courseId,
                externalCourseId,
                releaseId,
                previousOutput + output,
              );
            }
          }
        }
        proseTail = '';
        input = input.slice(match[0].length);
      }
      previousOutput += output;
      return output;
    },
    requestedObjects,
    finish(selected: LectureReference[] = [], answer = '') {
      const tail =
        (/ref:/i.test(pending) ? '' : pending) + (pendingBang ? '!' : '');
      pending = '';
      pendingBang = false;
      const pendingObjects = new Map(requestedObjects);
      for (const ref of appendUnused ? [...references, ...selected] : selected)
        pendingObjects.set(ref.id, ref);
      const unused = [...pendingObjects.values()].filter(
        (ref) => !objectIds.has(ref.id),
      );
      for (const object of unused) objectIds.add(object.id);
      return (
        tail +
        (unused.length
          ? '\n\n' +
            unused
              .map((object, index) => {
                if (
                  object.kind === 'latex' &&
                  containsFormula(answer, object.value)
                )
                  return (
                    (object.code && releaseId && !answer.includes(object.code)
                      ? object.label
                      : '') + formulaIdentity(object, releaseId)
                  ).trim();
                if (
                  object.kind === 'image' &&
                  releaseId &&
                  [
                    ...answer.matchAll(/!\[[^\]\n]*\]\((\/api\/[^)\s]+)\)/g),
                  ].some(
                    (match) =>
                      match[1] === imageUrl(object, courseId, externalCourseId),
                  )
                )
                  return `[exhibit:${releaseId}:${object.id}]: #focus`;
                return lectureReferenceMarkdown(
                  object,
                  courseId,
                  externalCourseId,
                  releaseId,
                  index === 0 ? (answer || previousOutput) + tail + '\n\n' : '',
                );
              })
              .join('\n\n')
          : '')
      );
    },
  };
}
