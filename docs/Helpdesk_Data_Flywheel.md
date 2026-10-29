# Helpdesk data flywheel (v5 Part G3 to G6, Admin server)

Specs: `helpdesk-v5-context-chips-and-smalltalk.md` Part G, and `helpdesk-v5-faq-graph-design.md` §3 and §5 item 5. The staff screens are not built yet; they will reuse antd and need visual sign-off (待视觉验收).

## Where the data comes from

**Admin cannot read Portal's database.** Every number and every learner phrase in the flywheel comes from Portal's integration feed, `GET /api/integration/helpdesk/insights` (contract fixture v7). Admin calls it nightly through `portalHelpdeskClient.insights` and stores the rows in its own fact table, `helpdesk_insight_turns`.

- **Learner text.** Portal runs its code-only PII scrubber before any text leaves Portal. Placeholders look like `<email>`, `<phone>` and `<name>`.
- **Everything else** is an enum label: kind, guard, vote, rating, covered, handover, the ticket outcome, and signals.
- **What the feed never contains:** learner ids, names, emails, orders, ticket ids or titles, answer text, or trace ids.
- **Upserts** are idempotent by Portal's turn id. A row that has not changed is not touched.
- **Pull window.** Each pull starts 72 hours before the newest stored turn, so late votes, ratings and ticket outcomes settle. The first pull covers the last 30 days. One night reads at most 200 pages of 500 turns; if more remain, `moreDue` is set and the next run carries on.
- **If Portal is not configured,** the run skips the pull and still mines (`not_connected`). If Portal fails, the run still mines what is stored, but the run is recorded as failed and is retried.
- **Raw text retention** (180 days, then scrubbed text and labels only) is Portal's job, `assist_retention`. Admin only shows its runs and has a "run now" button (see the endpoints below).

## Nightly gap mining (G3)

The code is in `server/src/backoffice/modules/helpdesk/flywheel/`.

1. **Select.** Take the unsolved turns from the last 30 days that no candidate holds yet, newest first, at most 2,000. A turn is unsolved if it has `no_match`, a `not_helpful` vote, a clarify that was not covered, a handover, a ticket after the chat, or a rating of 2 or less.
   - The same rule exists in SQL (the `unsolved` column of the view) and in TS (`unsolvedReasons`).
   - Small talk, handover requests, greetings and farewells, prompt-injection attempts and private-data turns are never mined.
2. **Group.** Turns are grouped by meaning with the existing retrieval similarity: opencc forms, character n-grams and English stems, IDF weighted, compared by cosine to each group's centroid. This sits behind the `TextSimilarity` interface, so embeddings can replace it later.
   - Groups need at least 2 turns.
   - A turn close to an open or dismissed candidate grows that candidate instead. Dismissed candidates absorb their repeats and do not come back to the queue.
3. **Label.** Each new group gets one small guarded model call, larger groups first, at most 30 calls and USD 0.10 a night. The call is made through `HELPDESK_GAP_LABELLER`, which `app.module.ts` wires to the Agent's pi step runner and the suggest model.
   - The model sees up to 5 scrubbed examples. It returns a topic, one learner-style question and a category enum. It never writes answers.
   - Both texts pass `guardGapLabel`, which rejects markup, emails, links, digits or number words not found in the examples, overlong text, AI filler and wrong script.
   - With no `OPENROUTER_API_KEY`, under `NODE_ENV=test`, over budget, on error or timeout, or when the guard fails, a code label is used instead.
4. **Dedupe.** Each group is compared with the working table's published answer nodes (their questions and phrasings), which gives one of three suggestions:
   - `add_phrasing` to node X, when the score is 0.5 or more;
   - `follow_up` under `parent_node_id`, when most members were shown children of the same parent;
   - otherwise `new_faq`.
5. **Store.** `helpdesk_faq_candidates` holds the topic, the proposed question, the count, at most 5 scrubbed examples, the related, parent and shown nodes, the source mix, at most 3 scrubbed human replies from resolved enquiries (draft sources only), and the status (new, accepted, dismissed or merged), plus the reason and an audit trail.
   - `helpdesk_faq_candidate_turns` makes a turn belong to at most one candidate, so re-runs never double count.

**Scheduling** happens in process. `HelpdeskFlywheelScheduler` starts after application bootstrap. It first checks 2 to 3 minutes after start and then every 30 minutes, with unref'd timers, so it never blocks startup or shutdown.

- From 18:00 UTC (02:00 Beijing time), a check takes the PostgreSQL advisory lock `(719320, 1)` and claims the day's row in `helpdesk_flywheel_runs`. The day's run happens once, which makes it idempotent per day.
- A failed run is retried, up to 3 attempts a day. A run whose heartbeat is more than 30 minutes old is taken over.
- Each run writes one structured log line: `{"type":"helpdesk","event":"flywheel_job_run",...}`, with counts and error codes only, never text.
- **No new ops config.** It needs no AWS and no scheduler outside the app. The scheduler is not started under `NODE_ENV=test`.

## Staff endpoints (G3 and G4)

All endpoints are under `/api/helpdesk/`. The guard is menu `helpDesk`: GET needs VIEW, writes need FULL. The actor is always the signed-in employee. Decisions carry `version`, and an optional `Idempotency-Key` makes the same decision replay as 200. A different decision with the same key is 422, and a stale version is 409 `CANDIDATE_CHANGED`. Each decision writes a revision row in the same transaction (`helpdesk_faq_candidate_revisions`, append-only).

| Method and path | What it does |
| --- | --- |
| `GET faq-candidates?status&suggestion&origin&q&page&pageSize` | The queue, biggest groups first, with per-status counts and node summaries |
| `GET faq-candidates/:id` | One candidate, its revisions and its nodes |
| `GET faq-candidates/:id/draft` | Prefill for a new FAQ or a follow-up: questions by language, category, placeholder-free phrasings. **The answer is empty for staff to write.** `answerDraft` holds only human replies from resolved enquiries, labelled 草稿 待核实 / "Draft, to be verified" |
| `POST faq-candidates/:id/accept` `{as, faqId, parentId?, phrasings?, version}` | `as` is one of `add_phrasing`, `new_faq` or `follow_up`. FAQs have no draft state (saving publishes), so for `new_faq` and `follow_up` staff create the node with `POST faqs` from the draft first, then accept with its `faqId`. `follow_up` also links `parentId` to `faqId`. The chosen examples become `flywheel` phrasings. **Every example becomes a regression case for that node.** |
| `POST faq-candidates/:id/dismiss` `{reason, note?, version}` | `reason` is one of duplicate, not_a_gap, out_of_scope, personal_data, spam or other; `other` needs a note. The note is scrubbed |
| `POST faq-candidates/:id/merge` `{targetId, version}` | Moves turns, counts and examples into an open candidate |
| `POST tickets/:ticketId/faq-candidate` | "转成 FAQ 候选". Only for a resolved enquiry (CLOSED, not cancelled). Takes the learner's first message and the last public agent reply and scrubs them **in Admin** with the same scrubber (`piiScrubber.ts`, corpus pinned by hash in both repos) plus the learner's own name and emails. The reply becomes a draft source only. Idempotent per ticket: 201, then 200 |
| `GET faq-eval-cases` | The regression cases as JSON Lines `{faqKey, locale, text}` |
| `GET flywheel/jobs/gap_mining/runs`, `GET …/runs/:runId` | The run rows: status, attempts, counts, duration, error code, who started it |
| `POST flywheel/jobs/gap_mining/run` (Idempotency-Key required) | Run now: 201 new (it runs in the background; poll the run), 200 same key, 409 `JOB_ALREADY_RUNNING`. Audited (`HELPDESK_JOB_RUN`) |
| `GET jobs/assist-retention`, `POST jobs/assist-retention/run` | Portal's retention job: its runs, and run now (Portal does the locking and idempotency). Audited |
| `GET flywheel/metrics?granularity=day\|week&from&to&split=none\|locale\|entry\|signal` | See G6 below |

## Release gate (G5)

The retrieval gate run before publishing (`createRetrievalGate`) also evaluates `helpdesk_faq_eval_cases`, labelled with the node staff chose. Cases for nodes that are not retrievable entry answers in that release are counted in `regressionSkipped`. The metrics also report `regressionCases`.

**CI** has a job named "HelpDesk eval gate" in `.github/workflows/ci.yml`. It is free: no model and no key. It runs four specs with `CI=true`, so a missing database fails the job instead of skipping:

- `helpdesk-eval-gate.pg.spec.ts` seeds `server/eval/helpdesk/faq-library.json` (the reviewed v2 library without its evidence) through the normal services and publishes v1. Recall@8 must be at least 95% over the questions, the phrasings and `server/eval/helpdesk/regression-cases.jsonl`.
- The guard corpus (`guard.spec.ts`, `gap-labeller.spec.ts`).
- The shared PII corpus (`helpdesk-pii-corpus.spec.ts`).

To grow the regression file, export `GET /api/helpdesk/faq-eval-cases` and append the lines. Portal's CI has the matching "HelpDesk scrubber corpus" job.

## Metrics (G6)

All metrics come from SQL over the view `helpdesk_insight_turn_facts`, with no second data source. Where a denominator is 0, the rate is `null`.

| Metric | Definition |
| --- | --- |
| AI-solved rate | Answers at least 24 h old with no ticket within 24 h, over answers at least 24 h old |
| no_match rate | `no_match` turns over all turns |
| Helpful rate | helpful + solved, over all votes |
| Average rating | Mean of the ratings given |
| Handover rate | Handover turns over all turns |
| Clarify covered rate | Covered clarifies over all clarifies |
| Guard fallback rate | Guard result other than `passed`, over turns that have a guard result |

- **Granularity:** daily (up to 92 days) or weekly (up to 366 days).
- **Splits:** by locale, by entry or by signal. Signals are unnested, and `none` means no signal.
- **Also returned:** the top 10 gap groups, the 10 FAQs that most often lead to a ticket within 24 hours, and `lastIngestedAt`.

**"Entry" is the turn's `source`** (submit, chat or chip). Portal's feed has no entry page, so a page-level split needs a new Portal field first.
