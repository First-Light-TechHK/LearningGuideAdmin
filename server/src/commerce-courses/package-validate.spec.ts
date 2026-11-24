import { validateCourseContent } from './package-validate';
import type { PackageCourse } from './contracts/manifest';

/** 一个结构完整的 VIDEO_ONLY 课程，可注入视频时长与学习点时间。 */
function course(
  durationSeconds: number | undefined,
  timeSeconds: number,
): PackageCourse {
  return {
    code: 'C1',
    slug: 'c1',
    category: 'Science',
    learningMode: 'VIDEO_ONLY',
    learningLanguages: ['en-GB'],
    defaultContentLanguage: 'en-GB',
    cover: 'cover.png',
    localized: {
      'en-GB': {
        title: 'Course',
        shortDescription: 'Short',
        overview: 'Overview',
        whatYouLearn: ['One'],
      },
    },
    lessons: [
      {
        code: 'L1',
        order: 1,
        localized: {
          'en-GB': {
            title: 'Lesson 1',
            video: {
              file: 'videos/l1.mp4',
              ...(durationSeconds === undefined ? {} : { durationSeconds }),
              learningPoints: [{ code: 'LP1', timeSeconds, title: 'Point' }],
            },
          },
        },
      },
    ],
    trial: { enabled: false, lessons: [] },
    pricing: [],
  };
}

describe('validateCourseContent — 学习点时间与视频时长（Design §17.4 #14）', () => {
  it('Import 阶段就把「超过视频时长」定为阻断错误', () => {
    const report = validateCourseContent(course(100, 120));
    expect(report.errors.map((issue) => issue.code)).toContain(
      'LEARNING_POINT_TIME_BEYOND_VIDEO',
    );
  });

  it('学习点在时长内不报错；没有声明时长时无法判定，不臆造', () => {
    expect(
      validateCourseContent(course(100, 90)).errors.map((issue) => issue.code),
    ).not.toContain('LEARNING_POINT_TIME_BEYOND_VIDEO');
    expect(
      validateCourseContent(course(undefined, 9999)).errors.map(
        (issue) => issue.code,
      ),
    ).not.toContain('LEARNING_POINT_TIME_BEYOND_VIDEO');
  });
});
