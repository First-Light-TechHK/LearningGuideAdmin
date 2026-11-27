export interface LectureReference {
  id: string;
  code?: string;
  label: string;
  requires: string[];
  kind: 'image' | 'latex';
  value: string;
}

export function readLectureReferences(
  payload: Record<string, unknown>,
): LectureReference[] {
  if (payload.refObjects === undefined) return [];
  if (!Array.isArray(payload.refObjects) || payload.refObjects.length > 12)
    throw new Error('invalid refObjects');
  const ids = new Set<string>();
  return (payload.refObjects as unknown[]).map((raw) => {
    const object = raw as Partial<LectureReference> | null;
    if (
      !object ||
      typeof object.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(object.id) ||
      ids.has(object.id) ||
      typeof object.label !== 'string' ||
      !object.label.trim() ||
      /[[\]\r\n\\]/.test(object.label) ||
      !Array.isArray(object.requires) ||
      object.requires.some(
        (value) => typeof value !== 'string' || !value.trim(),
      ) ||
      typeof object.value !== 'string' ||
      !object.value.trim() ||
      (object.kind !== 'image' && object.kind !== 'latex') ||
      (object.kind === 'image' &&
        !/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/i.test(object.value)) ||
      (object.kind === 'latex' &&
        (object.value.length > 2000 || /[$<>]/.test(object.value)))
    )
      throw new Error('invalid lecture reference');
    ids.add(object.id);
    if (object.kind === 'latex') {
      // Older formula cards can have one trailing slash between simple population-vector rows.
      const value = object.value.replace(
        /\\begin\{([bp]?matrix)\}[\s\S]*?\\end\{\1\}/g,
        (matrix) =>
          matrix.replace(
            /(\b[A-Za-z]\(t\)[ \t]*)\\(?=[ \t]*\r?\n[ \t]*[A-Za-z]\(t\))/g,
            '$1\\\\',
          ),
      );
      return { ...object, value } as LectureReference;
    }
    return object as LectureReference;
  });
}

export function teachingReferenceCatalogue(authored?: Record<string, unknown>) {
  const objects = new Map<string, LectureReference>();
  for (const value of Array.isArray(authored?.cards)
    ? (authored.cards as unknown[])
    : []) {
    if (!value || typeof value !== 'object') continue;
    const payload = (value as { approvedPayload?: unknown }).approvedPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      continue;
    for (const object of readLectureReferences(
      payload as Record<string, unknown>,
    )) {
      const existing = objects.get(object.id);
      if (
        existing &&
        (existing.kind !== object.kind ||
          existing.value !== object.value ||
          existing.label !== object.label ||
          JSON.stringify(existing.requires) !== JSON.stringify(object.requires))
      )
        throw new Error(`conflicting reference: ${object.id}`);
      objects.set(object.id, object);
    }
  }
  return objects;
}

export function wikiTeachingReferenceIds(markdown: string): string[] {
  const ids = new Set<string>();
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      if (
        mark &&
        mark[1][0] === fence[0] &&
        mark[1].length >= fence.length &&
        !mark[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (mark) {
      fence = mark[1];
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;
    const prose = line.replace(/(`+)[^`]*\1/g, '');
    for (const match of prose.matchAll(
      /(?<!\\)\[[^\]\n]*\]\(refobj:([^\s)]+)\)/g,
    ))
      ids.add(match[1]);
  }
  return [...ids];
}
