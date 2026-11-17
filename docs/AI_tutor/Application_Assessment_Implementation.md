# Application Assessment implementation

## Approved scope

The screenshot defines layout and fields only. Its sample answer is not a grading benchmark. Reuse the existing Course mapping and current published Release. Do not change knowledge content, create a Release, or add question-to-knowledge mappings. Assessment instructions remain English; feedback follows locale. No per-question rubric is required.

## Phase 1: contract and prompt

Implemented in phase 1: `server/src/contracts/application-assessment.ts` defines the service request, model feedback, reference state and assembled result. Its parser validates the complete model output before any result can be displayed. The new `server/src/ai/prompts/application-assessment.md` is separate from the existing humanities conversation assessment. It is loaded by ApplicationAssessmentService for the learner evaluation endpoint.

Implemented endpoints:

- Portal: POST `/api/courses/:courseId/lessons/:lessonId/assessments/application/evaluate`, accepting `{clientEventId, expectedVersion, answer, locale}`.
- Backoffice: POST `/api/user/ai/application-assessment`, accepting ApplicationAssessmentRequest from the authenticated Portal service. Portal resolves the authored question and user identity itself. Browser-supplied question text, model selection, reference and prompt must not be trusted.

The backoffice result is wrapped by the existing global API envelope. Portal returns its own existing `{ok,data}` envelope. Model output contains feedback only. Services attach the exact submitted answer and reference from the existing Release. Public feedback fields map to Response, What you did well, and Area to improve; labels and colours are Portal i18n/UI concerns. The result also contains Your answer and Reference answer. No numerical score is introduced.

## Phase 2: backoffice service

Resolve externalCourseId through the existing KnowledgeClient and enforce Tutor Online/currentReleaseId. Reuse provider configuration, timeout, cancellation, logging and portal quota. Load the current Release once per evaluation. Use the authored question, not student instructions, to locate existing Q&A through current snapshot/retrieval APIs. Verify an extracted answer against original Release text; return unavailable if matching is ambiguous, absent or incomplete. Do not display a merely similar question or generate a replacement. No persistent mapping is added. Record the actual Release used in the result.

Invoke the new English prompt through the existing provider adapter, collect the complete output, parse JSON and call parseApplicationFeedback. Provider failures, invalid/truncated JSON and failed persistence never count as successful evaluation. needsReview produces a needs_review result, not a passing grade. The existing adapter exposes text streaming, so native JSON Schema support must not be assumed.

## Phase 3: Portal lifecycle

Check Session, current Entitlement, publication and exact Lesson ownership. Save the submitted answer and atomically claim an evaluation using existing version/event checks before calling backoffice. Prevent simultaneous evaluation of the same attempt; bound pending claims with a recoverable lease. Identical retries reuse the evaluation; Retake starts a new evaluation and retains historical results. Save feedback, original answer, reference snapshot and Release identity together. Ordinary draft PUT must not overwrite server evaluation evidence. Replace timer-based completion and reject client-forged evaluated state. Existing submitted records remain historical submissions, not AI evaluations.

First version uses a bounded synchronous request with an indeterminate loading state. On failure retain the answer and allow retry. Do not promise background completion after navigation without durable execution. Missing references display a localised unavailable state; feedback can still be evaluated when available course evidence is sufficient.

## Phase 4: presentation and input

Render the five screenshot regions using typed fields, not model-created headings or HTML. Collect and validate the complete response before displaying success. Support empty strength/improvement arrays through localised neutral copy. Reuse the existing Markdown/KaTeX rendering for feedback, submitted answer and reference, including tables and long formulas. Keep the result scroller separate from Retake. Add shared textarea formula insertion and edit/preview for Knowledge/Application inputs; preserve raw LaTeX, draft behaviour and current limits. No new editor dependency.

## Phase 5: functional acceptance

Run lint, typecheck and relevant tests at each implementation step. Use isolated fixtures for contract errors, unavailable references, provider errors, access denial, replay/conflict, refresh/retry/Retake and bilingual responsive maths rendering. Finally verify the existing backoffice connection and Course Release with controlled real requests. This is functional acceptance, not sample-answer grading or a grading-quality research project. Do not publish/commit/push without owner instruction.

Status: phases 1–4 implemented. Phase 5 local fixture verification and both builds passed. After the owner restarted backoffice, a real backoffice evaluation using the existing Modeling Life Release passed (HTTP 201, application_feedback.v1, evaluated, original answer preserved, reference available). The runtime Portal build and served assets were verified on port 3014; an unauthenticated evaluation request returns 401 as expected. A signed-in browser submission by the owner remains the final user acceptance step. No knowledge write or persistent configuration change was performed.

Phase 1 validation: `npx eslint src/contracts/application-assessment.ts src/contracts/application-assessment.spec.ts` passed; `npx tsc --noEmit --incremental false` passed; `npm test -- --runInBand src/contracts/application-assessment.spec.ts` passed (22 tests). Fixtures exercise protocol behaviour only and do not grade the screenshot answer.


## Phases 2–5 validation and changed files

Backoffice: scoped ESLint, `npx tsc --noEmit --incremental false`, `npm test -- --runInBand src/ai/application-assessment.service.spec.ts src/contracts/application-assessment.spec.ts src/ai/rate-limit.service.spec.ts` (37 passed), and `npm run build` passed.

Portal: `npm run lint` (0 errors, 13 existing image warnings), `npm run typecheck`, and the targeted Node suite (20 passed) passed. Suite files: application-assessment-api, application-assessment-page, knowledge-test-page, understanding-overview, understanding-overview-page, modeling-life-lesson2-assessment-api and ks-tutor-client. `NEXT_DIST_DIR=test-results/application-assessment-build npm run build` passed with existing CSS/image warnings. Next-generated edits to tsconfig.json and next-env.d.ts were restored. Bilingual desktop/mobile screenshots were inspected. All model responses in tests are fixtures, not evaluations of the screenshot sample.

Reference lookup currently supports unambiguous, complete question matches in numbered Qn/An Markdown sections. Other formats safely return unavailable; no knowledge edits or fabricated reference are made. Runtime provider selection uses the existing Course Release configuration. Application instructions come from the separate English prompt file, not the humanities dialogue prompt override. Evaluation shares the existing portal quota. Historical overview results retain band values during Retake; numeric AI scores are not introduced.

Changes in Backoffice-dev:
- server/src/ai/ai.module.ts
- server/src/ai/application-assessment.controller.ts
- server/src/ai/application-assessment.service.ts
- server/src/ai/application-assessment.service.spec.ts
- server/src/ai/application-reference.ts
- server/src/ai/dto/application-assessment.dto.ts
- docs/AI_tutor/Application_Assessment_Implementation.md

Changes in LearningGuidePortal-dev:
- contracts/application-assessment.ts
- contracts/lesson-assessment.ts
- services/applicationAssessmentService.ts
- services/ksTutorClient.ts
- services/lessonAssessmentService.ts
- app/api/courses/[courseId]/lessons/[lessonId]/assessments/application/evaluate/route.ts
- components/portal/AssessmentAnswerInput.tsx
- components/portal/assessment-answer-input.module.css
- components/portal/ApplicationTestDialog.tsx
- components/portal/application-test-dialog.module.css
- components/portal/KnowledgeTestDialog.tsx
- components/portal/PersistedAssessmentDialog.tsx
- components/portal/UnderstandingOverview.tsx
- messages/en-GB.json
- messages/zh-CN.json
- tests/unit/application-assessment-api.test.ts
- tests/unit/application-assessment-page.test.ts
- tests/unit/knowledge-test-page.test.ts
- tests/unit/modeling-life-lesson2-assessment-api.test.ts
- tests/unit/understanding-overview.test.ts
- tests/unit/understanding-overview-page.test.ts
- docs/phase1/api-contracts.md
- docs/phase1/domain-model.md
- docs/phase1/requirements-map.md
- docs/phase1/release-runbook.md


## Local production build correction (2026-11-16)

The owner runs `npm run stripe:local`, whose script uses `next({dev:false,dir:repo})`; it consumes the default `.next` production build. The earlier validation build was intentionally under test-results/application-assessment-build and therefore did not update the running application. Evidence before correction: default build lacked the evaluation route and port 3014 returned HTML 404, while the isolated build contained the route.

Stopped only the verified 3014 Portal process and its Stripe listener, ran `npm run build` without NEXT_DIST_DIR, and restarted the unchanged local-stripe-sandbox.mjs script in a hidden background process. The script reported ready with the same port and paired Stripe listener; no .env or startup-script change. After correction, default build contains the route, port 3014 returns JSON 401 for an unauthenticated evaluation request, and the served JS includes the new evaluation UI. The live backoffice call used a separate synthetic answer, not the screenshot sample, and returned a reference from the existing Release.

For this local production workflow, future source changes require stopping the current Portal, running `npm run build`, then `npm run stripe:local`. Restarting alone does not compile source. Existing submitted records do not acquire AI feedback automatically; Retake submits a new evaluation. Runtime logs are in the Portal's ignored test-results/portal-stripe-runtime.log and portal-stripe-runtime.error.log. No commit, push, knowledge update or billing transaction was performed.


## Three-band assessment revision (2026-11-16)

The owner's final labels supersede the earlier five-band wording: Strong / Developing / Needs review. The English application prompt and strict model contract now use application_feedback.v2 with only strong, developing, needs_review. Portal labels are Strong / Developing / Needs review (en-GB) and 理解扎实 / 逐步掌握 / 需要回顾 (zh-CN). Legacy sample Strong wording follows the same display.

Existing five-band records are mapped only when displayed: strong stays strong; mostly_good and partial become developing; weak and insufficient_evidence become needs_review. This mapping covers the result page, Understanding summaries and latest results retained during Retake. Historical records are not rewritten and not re-evaluated. New model output rejects v1 and obsolete bands. The needsReview boolean remains an evidence/human-confirmation flag; a learning grade of needs_review can have needsReview=false.

Changed files for this revision: Backoffice server/src/contracts/application-assessment.ts and .spec.ts, server/src/ai/prompts/application-assessment.md, server/src/ai/application-assessment.service.spec.ts; Portal contracts/application-assessment.ts, contracts/lesson-assessment.ts, components/portal/ApplicationTestDialog.tsx, services/lessonAssessmentService.ts, messages/en-GB.json, messages/zh-CN.json, tests/unit/application-assessment-api.test.ts, tests/unit/application-assessment-page.test.ts, tests/unit/understanding-overview.test.ts, tests/unit/understanding-overview-page.test.ts, and Phase 1 API/domain/requirements/release documentation.


Three-band verification: `npx eslint --fix src/contracts/application-assessment.ts src/contracts/application-assessment.spec.ts src/ai/application-assessment.service.spec.ts`, `npx tsc --noEmit --incremental false`, and `npm test -- --runInBand src/contracts/application-assessment.spec.ts src/ai/application-assessment.service.spec.ts` passed (35 tests). Portal `npm run lint`, `npm run typecheck`, `node --import tsx --require ./scripts/register-tsconfig-paths.cjs --test --test-concurrency=1 tests/unit/application-assessment-api.test.ts tests/unit/application-assessment-page.test.ts tests/unit/application-test-page.test.ts tests/unit/understanding-overview.test.ts tests/unit/understanding-overview-page.test.ts` (8 tests), and default `npm run build` passed. Live backoffice returned HTTP 201/application_feedback.v2/developing on a separate synthetic answer. The restored 3014 runtime serves the three labels. Existing warnings only; no commit/push, knowledge write or configuration edit.


## Unified save, submission and revision flow (2026-11-16)

Implemented 3000ms inactivity autosave with dirty/saving/saved/error messaging. Submission cancels the debounce, waits for in-flight autosave, reconciles uncertain versions and directly submits the latest answer for server persistence before AI; no prerequisite draft PUT. Confirmation supports cancel/Escape with focus on Keep editing. Clear draft is secondary and confirmed. Revise answer is available from both result entry contexts and preserves the answer; Continue restores saved revision text. Draft writes retain immutable server submissions snapshots including original answers and feedback. Existing evaluated results are copied to snapshots on first revision save. Same-event evaluation retries reuse the submission id. Pending/uncertain states are queried, read-only, and may be exited without withdrawing submission; expired claims offer retry. Draft-save, submission and evaluation errors use separate text, and editing clears stale submission errors.

Files changed in LearningGuidePortal-dev: components/portal/ApplicationTestDialog.tsx, components/portal/PersistedAssessmentDialog.tsx, contracts/lesson-assessment.ts, services/applicationAssessmentService.ts, services/lessonAssessmentService.ts, messages/en-GB.json, messages/zh-CN.json, tests/unit/application-assessment-api.test.ts, tests/unit/application-assessment-page.test.ts, tests/unit/application-test-page.test.ts, tests/unit/understanding-overview-page.test.ts, docs/phase1/api-contracts.md, docs/phase1/domain-model.md, docs/phase1/requirements-map.md, docs/phase1/release-runbook.md.

Validation: npm run lint (zero errors, existing 13 image warnings); npm run typecheck; Node regression files application-assessment-api, application-assessment-page, application-test-page, understanding-overview, understanding-overview-page (8 relevant test cases passed across final focused runs). Final page/API/Understanding-browser rerun passed 3/3; additional confirmation-focus/screenshot rerun passed 1/1. All upstreams in these tests are fixtures. npm run build passed on the final source. Restarted the unchanged stripe:local script on 3014; health and actually served JS confirmed the new flow. English confirmation screenshot inspected. No dependency/configuration/SQL/knowledge changes and no commit/push.
