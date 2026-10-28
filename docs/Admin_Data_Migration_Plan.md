# Admin data migration plan

Scope: the BackOffice service in this repository (NestJS + Prisma + its own
PostgreSQL), across DEV, SIT, UAT and PPE/PROD. It shares the S3 data bucket with
the Portal but never shares the database.

This document decides **which mechanism owns which kind of change**, so schema,
seed, content and ad-hoc fixes do not get mixed into one path.

## 1. Change taxonomy

| Kind | Examples | Owner mechanism |
|---|---|---|
| Schema | new column, index, enum, constraint | Prisma Migrate (`server/prisma/migrations`) |
| Reference data | RBAC permissions, default admin, feature defaults | idempotent seed, run after migrate |
| Content authored in the UI | employee, course, page/knowledge, tags, AI config | Admin API + audit log, never SQL |
| Bulk / ad-hoc data fix | backfill `externalId`, retitle pages, re-tag courses, merge duplicates | versioned data-change script + ledger |
| Media objects | course covers, lesson media | S3 under the Portal key contract (see §5) |
| Cross-system state | Portal course/lesson titles → admin `externalId` | `POST /api/sync/structure`, idempotent |

Rule: if a human would click it in the UI, it is a CRUD change. If it must run
identically on four databases, it is a script. If it changes shape, it is a
migration.

## 2. Why not a single mechanism

| Mechanism | Good for | Failure mode here |
|---|---|---|
| Script run by hand | one-off fixes, incident repair | no record of who ran what, drifts between environments |
| Auto at application boot | schema + tiny idempotent seeds | long data work blocks startup; a restart mid-run repeats work; four replicas race |
| Deploy with application (image + explicit one-shot task) | migrations and data changes with a single audit trail | needs a task runner and an approval step |

Current state: `start-admin.sh` already does `prisma migrate deploy` with
`set -e`, so a bad migration prevents the service from starting. That is
acceptable for additive schema changes and unacceptable for data work.

Decision:

- **Schema**: keep Prisma Migrate, but only additive/expand-contract changes.
- **Reference data**: idempotent seed executed right after migrate.
- **Data changes**: a separate one-shot task using the same image, never the web
  start path.
- **Content**: the API only.

## 3. Data-change runner

Layout:

```
server/prisma/data-changes/
  0001_backfill_page_external_id.ts
  0002_retitle_duplicate_pages.ts
  index.ts          # ordered registry, like the Portal's data-migrations
  types.ts
```

Ledger table (new Prisma migration):

```sql
CREATE TABLE "DataChangeRun" (
  "id"           TEXT PRIMARY KEY,          -- e.g. 0002_retitle_duplicate_pages
  "checksum"     TEXT NOT NULL,             -- sha256 of the script at run time
  "appliedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "durationMs"   INTEGER NOT NULL,
  "actor"        TEXT NOT NULL,             -- CI run id or operator identity
  "environment"  TEXT NOT NULL,
  "result"       JSONB NOT NULL             -- counts per table, dry-run report
);
```

Runner contract:

- `npm run data:change -- --name=<id> [--dry-run]`
- Refuses to run when the recorded checksum differs (script edited after being
  applied) — requires an explicit `--allow-checksum-change`.
- Wraps each change in one transaction; long operations use batched updates with
  a bounded `lock_timeout`.
- Idempotent by construction: selecting on a predicate, not on "run once".
- Dry-run prints the exact row counts it would touch, per table.
- Never runs automatically at boot.

Execution per environment:

```
# one-off task, same image, overridden command
node dist/data-change/run.js --name=0002_retitle_duplicate_pages --dry-run
node dist/data-change/run.js --name=0002_retitle_duplicate_pages
```

In App Runner this is a separate service/manual task rather than the web
service; on ECS it is `run-task`. The point is one process, one transaction, one
ledger row.

## 4. CRUD ownership (employee, course, knowledge)

- Employees: created through `/api/admin/employees`, password reset through the
  notification module. The default admin is a seed, never a hand-inserted row.
- Courses: created/versioned/published in admin. Portal receives only what the
  publish step sends.
- Knowledge pages: `Page.externalId` is the stable link to a Portal lesson.
  Retitling must go through the sync or a data-change script, not raw SQL.
- Every write records an audit event (actor, before/after for title and state
  fields). Bulk changes must write one audit row per affected entity, tagged
  with the data-change id.
- Optimistic concurrency: version column or `updatedAt` guard, so a bulk script
  and a human editor cannot silently overwrite each other.

Never migrate Portal users into the admin database. The two identity domains are
different: Portal users are learners, admin rows are employees.

## 5. Shared S3 contract with the Portal

One bucket per environment, one key contract:

```
<DATA_S3_PREFIX>/course-media/<courseId>/<assetId>.<ext>
```

- Admin uploads go through a presigned PUT issued by the Portal (it owns the
  asset metadata and version id) or through an admin endpoint that calls the
  same signing code. Admin must not invent its own key layout.
- Objects are written once and never renamed. Replacements create a new
  `assetId`; the database row changes, not the object.
- Reads are presigned GETs with the version id recorded at upload, so a replaced
  object cannot change what a lesson plays.
- Deleting a course marks media orphaned; a separate reconciliation job lists
  bucket keys against database rows and reports (never auto-deletes).
- The admin database stores `assetId`, `courseId`, size, mime and checksum — not
  a full URL, because URLs are environment- and expiry-specific.

Migration consequence: a data-change script that moves media must (1) copy the
object under the Portal key contract, (2) insert/update the asset row, (3)
verify `HeadObject` size and checksum, and only then (4) update the content
reference. Never delete the old object in the same run.

## 6. Portal ↔ Admin boundary

- Admin reads Portal through `PortalSourceService` (HTTP), never by connecting to
  the Portal database.
- Publishing writes through the Portal API, so Portal rules (validation,
  versioning, media signing) stay enforced.
- `externalId` mapping is the only join key. If it is missing, the data-change
  script backfills it from `(course.slug, lesson.id)` and reports unmatched rows
  instead of guessing.
- Sync is idempotent and status-reporting (`synced`, `has_updates`,
  `not_synced`). It must remain safe to run repeatedly.

## 7. Environment sequence

For every schema or data change:

1. DEV: migrate, run the change with `--dry-run`, inspect counts, apply.
2. SIT: same, plus a smoke test of the affected admin screens.
3. UAT: apply during the release window; take a snapshot first.
4. PPE/PROD: snapshot, apply, verify counts, keep the previous image tagged for
   rollback.

Rollback policy: schema migrations are forward-only; a bad data change is
corrected by a new data-change script. Snapshot restore is the last resort and
requires an explicit decision.

## 8. Immediate work items

1. Add the `DataChangeRun` Prisma migration and the runner under
   `server/prisma/data-changes/`.
2. Add `npm run data:change` and a CI job that only runs `--dry-run`.
3. Split `start-admin.sh`: migrations and seeds may block startup; data changes
   must not be part of it.
4. Define the S3 upload endpoint using the Portal signing code, and store
   `assetId` + checksum in the admin schema.
5. Add the orphan-media reconciliation report (read-only).
6. Write the first real data change as a pilot (backfill `Page.externalId`) with
   a dry-run on SIT before touching UAT.
