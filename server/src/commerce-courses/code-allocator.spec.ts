import {
  formatApplicationCode,
  formatCourseCode,
  formatExhibitCode,
  formatKnowledgeCode,
  formatLearningPointCode,
  formatLessonCode,
  lessonNumber,
} from './code-allocator';

describe('code formats', () => {
  it('pads Course, Lesson and Exhibit IDs to three digits and grows past 999', () => {
    expect(formatCourseCode(1)).toBe('C001');
    expect(formatCourseCode(42)).toBe('C042');
    expect(formatCourseCode(1000)).toBe('C1000');
    expect(formatLessonCode(4)).toBe('L004');
    expect(formatExhibitCode(12)).toBe('E012');
  });

  it('builds question IDs from the lesson number and a sequence, both at least two digits', () => {
    expect(formatKnowledgeCode(2, 1)).toBe('K-0201');
    expect(formatKnowledgeCode(12, 7)).toBe('K-1207');
    expect(formatKnowledgeCode(2, 101)).toBe('K-02101');
    expect(formatApplicationCode(2, 1)).toBe('A-0201');
  });

  it('numbers learning points V1 and T1 without padding', () => {
    expect(formatLearningPointCode('VIDEO', 1)).toBe('V1');
    expect(formatLearningPointCode('TEXT', 12)).toBe('T12');
  });
});

describe('lessonNumber', () => {
  it('reads the trailing digits of a lesson code', () => {
    expect(lessonNumber('L003')).toBe(3);
    expect(lessonNumber('L3')).toBe(3);
    expect(lessonNumber('Lesson-12')).toBe(12);
  });

  it('uses the fallback when the code has no trailing number', () => {
    expect(lessonNumber('INTRO', 5)).toBe(5);
    expect(lessonNumber('INTRO')).toBe(0);
  });
});
