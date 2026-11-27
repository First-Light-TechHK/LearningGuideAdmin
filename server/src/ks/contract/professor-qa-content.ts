function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 旧快照保持可校验；仅在恢复编辑内容或读取匹配词时过滤退役字段。 */
export function cleanProfessorQa<T>(card: T): T {
  if (!record(card) || card.type !== 'professor_qa') return card;
  const payload = card.approvedPayload;
  if (!record(payload) || !('variants' in payload || 'keywords' in payload))
    return card;
  const cleaned = { ...payload };
  delete cleaned.variants;
  delete cleaned.keywords;
  const bilingual = card.bilingual;
  const variants = new Set(
    Array.isArray(payload.variants) ? payload.variants : [],
  );
  variants.delete(payload.question);
  if (!variants.size || !record(bilingual) || !record(bilingual.triggers))
    return { ...card, approvedPayload: cleaned };
  const triggers = { ...bilingual.triggers };
  for (const lang of ['en', 'zh']) {
    const terms = triggers[lang];
    if (Array.isArray(terms))
      triggers[lang] = terms.filter((term) => !variants.has(term));
  }
  return {
    ...card,
    approvedPayload: cleaned,
    bilingual: { ...bilingual, triggers },
  };
}

export function cleanProfessorQaPackage(
  base: Record<string, unknown> | undefined,
) {
  return base && Array.isArray(base.cards)
    ? {
        ...base,
        cards: base.cards.map((card: unknown) => cleanProfessorQa(card)),
      }
    : base;
}
