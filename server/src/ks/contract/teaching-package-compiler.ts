export const TEACHING_PACKAGE_COMPILER = Symbol('TEACHING_PACKAGE_COMPILER');

export type TeachingPackageCompiler = (input: {
  courseId: string;
  releaseId: string;
  snapshot: {
    pages: {
      id: string;
      title: string;
      contentMd: string;
      sectionTags?: unknown;
    }[];
  };
  authored: Record<string, unknown>;
}) => { teachingPackage: unknown; imageAssets: string[] };
