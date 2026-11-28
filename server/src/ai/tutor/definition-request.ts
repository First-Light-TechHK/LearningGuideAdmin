const followUp =
  /为什么|为何|如何|怎么|举例|例子|应用|用途|作用|推导|区别|比较|来源|哪一[页段]|\b(?:why|how|examples?|apply|used for|derive|difference|compare|which (?:slide|page))\b/iu;
const splitRequests =
  /[。；;！？?\n]+|(?:[，,]\s*|[，,]?\s*(?:以及|并且|并|再|和))(?=\s*(?:什么|为什么|为何|如何|怎么|能(?:否|不|从|看|用|判断)|可以|举例|引用|解释|讲稿))|[,]?\s+and\s+(?=(?:what|why|how|where|can|does|give|quote|explain|compare)\b)/iu;

export const asksForScript =
  /原话|原文|出处|讲稿.{0,10}(?:怎么说|如何说|哪一[段页])|\b(?:quot(?:e|ation)|verbatim|source|transcript|lecture notes)\b/iu;

export function asksForCourseScript(message: string) {
  return (
    asksForScript.test(message) &&
    (/讲稿|\b(?:transcript|lecture notes)\b/iu.test(message) ||
      !/教授(?:的)?(?:问答|原话|原文)|\bprofessor\b/iu.test(message))
  );
}

export function definitionNamePattern(name: string) {
  const term = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function asksForDefinition(request: string, name: string) {
  const exact = definitionNamePattern(name);
  const gloss = /\p{Script=Han}/u.test(name)
    ? '[a-z][a-z0-9 -]{0,59}'
    : '\\p{Script=Han}{1,20}';
  const term = `(?:${exact}(?:\\s*\\(\\s*${gloss}\\s*\\))?|${gloss}\\s*\\(\\s*${exact}\\s*\\))`;
  const part = request
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?。！!.]+$/u, '');
  return new RegExp(
    `^(?:请(?:问)?\\s*)?(?:(?:什么是|什么叫|定义)\\s*${term}|${term}\\s*(?:是什(?:么|麽)|什么(?:意思)?|的(?:含义|定义)))\\s*(?:呢|吗)?$` +
      `|^(?:please\\s+)?(?:(?:what (?:is|are) |define |(?:give )?the definition of )(?:an? |the )?${term}|what does ${term} mean)$`,
    'iu',
  ).test(part);
}

export function partitionDefinitionRequests(
  message: string,
  concepts: ReadonlyArray<readonly string[]>,
) {
  const covered: string[] = [];
  const remaining: string[] = [];
  for (const item of message.split(splitRequests)) {
    const part = item.trim();
    if (!part) continue;
    const matching = concepts.filter((names) =>
      names.some((name) => asksForDefinition(part, name)),
    );
    (matching.length === 1 ? covered : remaining).push(part);
  }
  return { covered, remaining };
}

export function definitionFollowUp(message: string) {
  const question = message
    .normalize('NFKC')
    .trim()
    .replace(/[?。!]+$/u, '');
  if (
    /^(?:(?:那|那么|请|可以|能不能)\s*)*(?:再)?(?:解释(?:一下|一遍)?|展开(?:说说|讲讲)?|详细(?:说说|解释一下)|讲得更清楚一点)(?:吗|呢|吧)?$|^(?:please\s+)?(?:(?:can|could) you )?(?:elaborate|explain (?:that|it)(?: further)?|explain a bit more)$/iu.test(
      question,
    )
  )
    return 'explain' as const;
  if (
    /^(?:(?:那|那么|请|可以|能不能)\s*)*(?:再)?(?:举|给)(?:一|个|一个)*(?:课上(?:的)?|课程里(?:的)?)?例子(?:吗|呢|吧)?$|^(?:please\s+)?(?:(?:can|could) you )?give (?:me )?an example$/iu.test(
      question,
    )
  )
    return 'example' as const;
  if (
    /^(?:那|那么)?\s*(?:讲稿(?:里|中)?(?:是)?(?:怎么说的|如何表述的)|(?:请|可以)?(?:引用|给我|看看)(?:讲稿)?原文)(?:吗|呢)?$|^(?:(?:can|could) you )?quote (?:the )?(?:lecture|script|transcript)(?: wording)?$/iu.test(
      question,
    )
  )
    return 'quotation' as const;
}

export function definitionGaps(
  message: string,
  names: string[],
  hasScript: boolean,
) {
  return message
    .split(splitRequests)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !names.some((name) => asksForDefinition(part, name)) &&
        ((!hasScript && asksForScript.test(part)) || followUp.test(part)),
    );
}
