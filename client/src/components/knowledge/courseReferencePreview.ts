import type { TeachingRef } from '../../api/teachingCards'

export type CourseReferencePreview = {
  courseId: string
  byId: ReadonlyMap<string, TeachingRef>
}

export function courseReferenceId(destination: string): string | undefined {
  return destination.startsWith('refobj:') ? destination.slice('refobj:'.length) : undefined
}

export function courseReferenceImageUrl(courseId: string, asset: string): string {
  return `/api/files/images/${encodeURIComponent(courseId)}/${encodeURIComponent(asset)}`
}
