export const TUTOR_IMAGE_SOURCE = Symbol('TUTOR_IMAGE_SOURCE');

export interface TutorImageSource {
  getImage(
    courseId: string,
    assetId: string,
  ): Promise<{
    bytes: Buffer;
    contentType: string;
  } | null>;
}
