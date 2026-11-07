# Helpdesk FAQ change log (BackOffice)

Every change to the Helpdesk question tree is recorded: who made it, when, and what changed (before and after). Staff read the record in BackOffice under Help Desk > Change Log, and per FAQ in the FAQ drawer's History tab. The screens follow the Figma drafts 2.6 to 2.9 that the owner approved on 2026-10-30.

## What is recorded

All records are append-only. A database trigger (`helpdesk_faq_append_only()`) rejects UPDATE and DELETE, and each row is written in the same transaction as the change it describes.

| Type | Source table | Written by |
| --- | --- | --- |
| FAQ (create, edit, delete) | `helpdesk_faq_revisions` | FAQ create / update / archive |
| Follow-up and option links (add, reorder, custom text, remove) | `helpdesk_faq_edge_revisions` | question tree editor |
| Phrasings (add, remove) | `helpdesk_faq_phrasing_revisions` (migration `20261103000000`) | question tree editor. Existing phrasings are backfilled as `create` rows with no employee |
| Releases (version created, published, rolled back) | `helpdesk_faq_releases` | release flow |

Rows without an employee are shown as "System" (seed or automatic writes). Names come from the employee's login email at read time.

## Do users see it yet

- If no release has ever been published, a change is live as soon as it is saved.
- Otherwise a change is live when the current published release was frozen at or after the change (a rollback counts from the release it copies).
- "Went live in" is the first non-rollback release published and created at or after the change.

## API

Both endpoints are under `/api/helpdesk/` and are read-only. The guard is menu `helpDesk` with VIEW, so anyone who can see FAQs can see who changed them.

`GET faq-changes`

| Parameter | Meaning |
| --- | --- |
| `subject` | `faq`, `follow_up`, `option`, `phrasing` or `release` |
| `employee` | `system` or an employee id |
| `faq` | only changes to this FAQ (as the FAQ, the parent or the child of a link) |
| `from`, `to` | a date (`YYYY-MM-DD`) or an ISO time. A date-only `to` includes that whole day. `from` must be before `to` |
| `q` | text in the question, key or changed text |
| `page`, `pageSize` | default 1 and 10, page size at most 50 |

Response: `{ changes, total, page, pageSize, people }`. Bad input is 400 `INVALID_INPUT`.

`GET faqs/:faqId/changes?page&pageSize`: one FAQ's history, newest first, with "went live" entries added for the releases its changes went live in. Reads at most 500 changes; `truncated` says when there were more.

## Screens

- Change Log tab: search, person, type and date range filters (kept in the address bar: `q`, `by`, `type`, `range`, `faq`, `page`), a paged table, and a details drawer with who, when (with the viewer's time zone), version, whether users see it, and a field by field diff. Long text marks only the changed stretch; keywords and situations show as removed / added chips.
- FAQ drawer: tabs Details, Follow-ups & phrasings, and History (editing only). "Open in Change Log" opens the Change Log filtered to that FAQ, all time.

## Not yet in the Change Log

FAQ map changes (`helpdesk_faq_map_revisions`, the SOP tree behind `HELPDESK_LOCATOR`) and card reviews (`helpdesk_faq_reviews`) are logged in their own append-only tables but are not shown in this timeline yet.

## Tests

- Server: `tests/helpdesk-faq-change-log.pg.spec.ts` (needs `HELPDESK_TEST_DATABASE_URL`), `tests/helpdesk-faq-change-log.spec.ts`, `tests/helpdesk-faq-changes-rbac.spec.ts`.
- Client: `tests/helpdesk-changes.test.ts`, `tests/helpdesk-changes-ui.test.tsx`, and the browser E2E `e2e/helpdesk-changes.e2e.test.mjs` (`npm run test:e2e:helpdesk`, local only).
