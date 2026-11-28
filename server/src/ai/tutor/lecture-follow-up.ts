import { comparisonSubjects } from './course-context';
import { definitionFollowUp } from './definition-request';

export function lectureFollowUpKind(message: string) {
  const text = message.normalize('NFKC').trim();
  const kind = definitionFollowUp(text);
  if (kind) return kind;
  if (
    /^(?:(?:请|可以|能不能)\s*)?(?:再(?:举|给|来)(?:一)?个|换(?:一)?个例子)|^(?:(?:can|could) you )?(?:give (?:me )?)?(?:another|a different) example\b/iu.test(
      text,
    )
  )
    return 'example' as const;
  if (
    /^(?:那|那么)?(?:它为什么|为什么(?:单位|数值|两者|这样)(?:重要|有用)|为什么(?:呢|会这样)|(?:and )?why(?: is that)?[?!.]*$)/iu.test(
      text,
    )
  )
    return 'reason' as const;
  if (
    /^(?:(?:那|那么)?如果(?:改用|换成|把|改成)|(?:and )?what if (?:we|it|you) (?:use|used|change|changed|is|were)\b)/iu.test(
      text,
    )
  )
    return 'condition' as const;
  if (
    /^(?:你刚才说的.{0,30}(?:出处|原文|讲稿)|(?:请|可以)?(?:引用|给我|展示)(?:(?:教授|老师)(?:的)?(?:问答)?)?(?:原话|原文)|(?:please )?quote (?:the )?(?:professor|original))/iu.test(
      text,
    )
  )
    return 'quotation' as const;
  if (/^(?:那)?这个呢[?。!]*$|^what about (?:that|it)[?!.]*$/iu.test(text))
    return 'clarify' as const;
  if (/^(?:那|那么)它/iu.test(text)) return 'explain' as const;
}

const units = [
  /华氏|fahrenheit|°\s*f\b/iu,
  /摄氏|celsius|°\s*c\b/iu,
  /开尔文|kelvin/iu,
];

export function followUpEvidenceMatches(
  goal: NonNullable<ReturnType<typeof resolveLectureFollowUp>>,
  question: string,
  excerpts: string[],
) {
  const text = excerpts.join('\n').normalize('NFKC');
  const activeConditions = [...goal.changes, question];
  const unit = activeConditions.findLast(
    (part) =>
      lectureFollowUpKind(part) === 'condition' &&
      units.some((pattern) => pattern.test(part)),
  );
  if (
    unit &&
    units.some((pattern) => pattern.test(unit) && !pattern.test(text))
  )
    return false;
  const asksAboutMeasurement =
    /数值.{0,12}单位|单位.{0,12}数值|numerical values?.{0,20}units?/iu.test(
      goal.anchor,
    );
  return (
    goal.kind !== 'example' ||
    !asksAboutMeasurement ||
    /\d+(?:[.,]\d+)?\s*(?:°\s*[cf]|%|[\p{L}]{1,18})/iu.test(text)
  );
}

export function resolveLectureFollowUp(
  message: string,
  history: readonly { role: string; content: string }[],
) {
  const requested = lectureFollowUpKind(message);
  if (!requested) return;
  const turns = history.filter((turn) => turn.role === 'user');
  const index = turns.findLastIndex(
    (turn) => !lectureFollowUpKind(turn.content),
  );
  const anchor = index < 0 ? '' : turns[index].content.trim();
  const changes = turns
    .slice(index + 1)
    .filter((turn) => {
      const intent = lectureFollowUpKind(turn.content);
      return (
        intent === 'condition' ||
        (intent === 'reason' &&
          /为什么(?:数值|单位)|why.{0,18}(?:units|value)/iu.test(
            turn.content,
          )) ||
        (intent === 'example' &&
          /换成|以.{1,25}为例|\binstead\b|\busing\b/iu.test(turn.content))
      );
    })
    .slice(-3)
    .map((turn) => turn.content.slice(0, 240));
  const ambiguous =
    !anchor ||
    anchor.split(/[?？；;]/u).filter((part) => part.trim()).length > 1 ||
    (comparisonSubjects(anchor).length > 1 &&
      (requested === 'quotation' || requested === 'clarify'));
  const kind = requested === 'clarify' && !ambiguous ? 'explain' : requested;
  const previousAnswer = history
    .findLast((turn) => turn.role === 'assistant')
    ?.content.slice(0, 1200);
  return {
    kind,
    anchor,
    changes,
    ambiguous,
    quotationSource:
      kind === 'quotation'
        ? /(?:教授(?:的)?(?:问答|原话|原文)|\bprofessor\b)/iu.test(message) &&
          !/讲稿|教材|lecture (?:script|notes)|transcript/iu.test(message)
          ? ('professor_qa' as const)
          : ('course_context' as const)
        : undefined,
    target: [anchor.slice(0, 4200), ...changes, message.slice(0, 2400)]
      .filter(Boolean)
      .join('\n'),
    previousAnswer:
      kind === 'quotation' || kind === 'example' ? previousAnswer : undefined,
    anotherExample:
      kind === 'example' && /再|换|another|different/iu.test(message),
  };
}
