export type FeedbackStatus = 'New' | 'Triaged' | 'Applied' | 'Dismissed'
export type FeedbackType = 'Student' | 'Expert'
export type FeedbackMode = 'LECTURE' | 'SOCRATIC'

export interface FeedbackRecord {
  id: string
  mode: FeedbackMode
  question: string
  answer: string
  suggestedAnswer: string | null
  knowledgeUsage: string | null
  context: string | null
  reportedBy: string
  type: FeedbackType
  courseId: string
  course: string
  lesson: string | null
  feedback: string
  submittedAt: string
  status: FeedbackStatus
  resolvedAt: string | null
}

export interface FeedbackFilters {
  courseId: string
  type: string
  mode: string
  status: string
  days: number
  search: string
}

export const emptyFeedbackFilters: FeedbackFilters = {
  courseId: '', type: '', mode: '', status: '', days: 0, search: '',
}

const common: FeedbackRecord = {
  id: 'DEMO-001', mode: 'SOCRATIC', question: 'What does the change vector tell us about shark and tuna populations?',
  answer: 'A positive value means growth and a negative value means decline.',
  suggestedAnswer: 'Inspect the two components separately. Which population is increasing?',
  knowledgeUsage: 'Teaching Sequence', context: 'Student: What do the axes represent?\nAI Tutor: Shark and tuna population sizes.', reportedBy: 'Expert Demo', type: 'Expert',
  courseId: 'demo-modelling', course: 'Modelling Life', lesson: 'Lesson 1 · State and change',
  feedback: 'Guide the learner to inspect each component.', submittedAt: '2026-11-02T06:32:00Z', status: 'New', resolvedAt: null,
}

const examples: readonly FeedbackRecord[] = [
  common,
  { ...common, id: 'DEMO-002', type: 'Student', mode: 'LECTURE', reportedBy: 'Student Demo 1842',
    question: 'Can you give me an example from this lesson?', answer: 'A state space represents the possible states of a system.',
    suggestedAnswer: null, knowledgeUsage: null, context: null, lesson: 'Lesson 1 · State space',
    feedback: 'This was too general. I wanted an example from the course material.', submittedAt: '2026-11-02T05:08:00Z' },
  { ...common, id: 'DEMO-003', status: 'Triaged', courseId: 'demo-history', course: 'Germany History',
    lesson: 'Lesson 3 · January 1933', question: 'Why did events change in January 1933?',
    answer: 'The political situation changed.', suggestedAnswer: 'Ask the learner to identify evidence first.',
    feedback: 'The Tutor gives away the answer too quickly.', submittedAt: '2026-11-01T09:41:00Z' },
  { ...common, id: 'DEMO-004', type: 'Student', status: 'Applied', courseId: 'demo-art', course: 'The Art of Seeing',
    reportedBy: 'Student Demo 0927', lesson: 'Lesson 1 · Looking closely', question: 'What can we see in this image?',
    answer: 'The image represents an idea.', suggestedAnswer: null, knowledgeUsage: null,
    feedback: 'Describe the visible evidence before interpreting.', submittedAt: '2026-11-01T03:24:00Z', resolvedAt: '2026-11-03T08:00:00Z' },
  { ...common, id: 'DEMO-005', status: 'Dismissed', mode: 'LECTURE', question: 'Is a trajectory the same as a vector field?',
    answer: 'A vector field gives a direction at each point; a trajectory is a path from an initial condition.',
    suggestedAnswer: null, knowledgeUsage: null, feedback: 'The distinction is clear. Thank you.',
    submittedAt: '2026-10-31T08:12:00Z', resolvedAt: '2026-11-02T07:20:00Z' },
  { ...common, id: 'DEMO-006', status: 'Triaged', lesson: null, question: 'How do I check the units?',
    answer: 'Check that both sides have compatible units.', suggestedAnswer: 'Compare the units of state divided by time.',
    knowledgeUsage: 'QA', feedback: 'Add a worked example of the units.', submittedAt: '2026-10-30T08:00:00Z' },
]

export const feedbackSource = {
  list: (): FeedbackRecord[] => examples.map((record) => ({ ...record })),
}

export function filterFeedback(records: readonly FeedbackRecord[], filters: FeedbackFilters, now = Date.now()): FeedbackRecord[] {
  const search = filters.search.trim().toLocaleLowerCase()
  const cutoff = now - filters.days * 24 * 60 * 60 * 1000
  return records.filter((record) => {
    if (filters.courseId && record.courseId !== filters.courseId) return false
    if (filters.type && record.type !== filters.type) return false
    if (filters.mode && record.mode !== filters.mode) return false
    if (filters.status && record.status !== filters.status) return false
    if (filters.days) {
      const time = Date.parse(record.submittedAt)
      if (!Number.isFinite(time) || time < cutoff || time > now) return false
    }
    return !search || [record.id, record.question, record.answer, record.suggestedAnswer,
      record.feedback, record.reportedBy, record.course, record.lesson].some((text) => text?.toLocaleLowerCase().includes(search))
  }).sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt) || a.id.localeCompare(b.id))
}
