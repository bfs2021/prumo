---
status: draft
last_reviewed: 2026-10-23
owner: '@raphaelfh'
---

# Screening v1 — Slice A (PubMed import, human review, PRISMA counts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project imports a PubMed result set by PMID, enrolls its articles, screens titles and abstracts blind with 1–3 reviewers and arbitration, and reads PRISMA identification and screening counts — human only, no AI.

**Architecture:** Migration `0094_screening_v1` adds three backend-only, INSERT-only tables (`screening_assignments`, `screening_decisions`, `screening_arbitrations`) and closes client writes on `article_sync_runs`/`article_sync_events`. PubMed joins the existing canonical-identity path: an NCBI `efetch` client and `normalize_pubmed_record` feed a fill-only upsert, run by a Celery task that writes one `article_sync_events` row per received PMID. Outcomes, queue state and PRISMA counts are derived on read from rows by one pure function (`screening_outcome.derive_state`); the API is the only reader and applies blind/reveal.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, Celery/Redis, Pydantic v2, httpx, stdlib `xml.etree`; React 19 + TanStack Query + shadcn, papaparse; pytest (real Postgres), Vitest + MSW, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-screening-v1-ai-prescreen-design.md` — slice A only: §4 (import), §5 (migration `0094` tables only), §7 (human review), §8 (PRISMA counts, not the AI-use statement), §9 (routes except `ai-prescreen`, `ai-run`, `calibration`), §10 (minus slice-B items), §12 (slice-A tests). Binding inputs: spec gate `.superpowers/sdd/2026-10-23-screening-v1-ai-prescreen-a/spec-gate.md`, ledger rulings `.superpowers/sdd/2026-10-23-screening-v1-ai-prescreen-a/progress.md`.

## Global Constraints

Each task restates the rules it relies on; this list is the index, not a substitute.

**Workspace**
- Worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, branch `claude/unruffled-kirch-2a8ec0`. Every git command is `git -C "$WT" …`. Never touch the main checkout `/Users/raphaelfedericcihaddad/PycharmProjects/prumo` and never `git switch`/`checkout` there. After editing, `git -C "$WT" status` must list your files.
- Out of scope (slice B): migration `0095`, the `'screen'` pass kind, any AI panel/run/suggestion, `ai_suggestion_id` / `ai_visible_at_decision` columns, `/screening/ai-prescreen`, `/screening/ai-run*`, `/screening/calibration`, the AI-use statement. Writing any of them fails review.
- Commits: conventional (`feat(screening): …`, `test(screening): …`), one or more per task, each ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no PR (the orchestrator opens it).

**Hard rules (AGENTS.md)**
- English only: code, comments, commits, docs, copy keys.
- Model change ⇒ Alembic migration in the same task: `cd "$WT/backend" && uv run alembic revision --autogenerate -m "…"` as a draft, then hand-edit (docstring with the why, explicit constraint names); revision id ≤ 32 chars; `uv run alembic check` must print `No new upgrade operations detected.`
- Seed data only through `cd "$WT/backend" && uv run python -m app.seed`, never in a migration (slice A adds no seed data).
- No dead code: `npx knip --no-tag-hints` and `npx knip --production --no-tag-hints` at zero (exceptions only in `knip.jsonc` with a reason); copy keys gated by `scripts/fitness/check_copy_keys.py`; backend vulture ratchet `cd "$WT/backend" && uv run python ../scripts/vulture_baseline.py --baseline .vulture_baseline --exec` (shrink-only — delete, never baseline).
- BOLA: every client-supplied id is bound by ONE guard with the scope in the WHERE clause (`.claude/rules/backend.md` § Ownership guards; gate `scripts/fitness/check_scope_guards.py`). Membership/role checks go through `app/api/deps/security.py` (`require_project_scope`, `require_project_manager`, `ensure_project_reviewer`, `ensure_project_arbitrator`); a service calls `public.is_project_*` SQL functions directly, never `project_members` SQL.
- Layering `api → services → repositories → models` (`scripts/fitness/check_layered_arch.py`): endpoints import schemas and services only; repositories `flush()`, never `commit()`; the endpoint commits.
- Every JSON response is `ApiResponse[T]` with a typed `T` (`scripts/fitness/check_api_response_envelope.py`); errors are `HTTPException` or an `AppError` subclass (`backend/app/core/error_handler.py:22`); a new error code is added to `ApiErrorCode` (`backend/app/schemas/common.py:51`) before use. Every endpoint has `@limiter.limit(...)` and takes `request: Request`.
- Frontend tooling runs from the repo root `$WT` (`package.json`, `vite.config.ts`, `vitest.config.ts`); never `cd frontend && npm …`. The worktree needs its own `node_modules`: run `npm ci` in `$WT` once (never symlink the main checkout's).
- `.claude/hooks/post-edit-format.sh` runs `ruff check --fix` / `eslint --fix` after every Edit/Write and strips unused imports: add an import in the same edit as its first use. Enable an eslint rule before adding an `eslint-disable` for it.
- Generated API types are never hand-edited: `npm run generate:api-types` from `$WT` (Task 9 does it once all backend schemas exist).

**Test database (integration tests) — never the shared Supabase DB**
- Never run `make db-fresh`, `make reset-db`, `make db-setup` or `supabase db reset`, and never `alembic upgrade` the shared local Supabase DB (port 54322) with `0094` — it is shared by every session and worktree. The one exception is Task 13's optional local Playwright run: coordinated first, and rolled back with `alembic downgrade 0093_batch_agent_origin` right after.
- Integration tests run against a dedicated Postgres for this worktree, built like CI (`postgres:17` + `backend/tests/integration/supabase_stub.sql` + `alembic upgrade head` + `app.seed`). Bootstrap once (Task 1 does it; later tasks reuse it — start the container if it is stopped):
  ```bash
  docker start prumo-screening-pg 2>/dev/null || docker run -d --name prumo-screening-pg -p 55433:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres postgres:17
  docker exec prumo-screening-pg psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='prumo_screening_a'" | grep -q 1 || docker exec prumo-screening-pg psql -U postgres -c "CREATE DATABASE prumo_screening_a"
  # $WT/backend/.env (gitignored; fake values only):
  #   DATABASE_URL=postgresql://postgres:postgres@localhost:55433/prumo_screening_a
  #   SUPABASE_URL=http://localhost:54321
  #   SUPABASE_SERVICE_ROLE_KEY=stub-service-role
  #   SUPABASE_ENV=local
  #   OPENAI_API_KEY=sk-test-not-real
  #   NCBI_EMAIL=dev@prumo.test
  cd "$WT/backend" && uv sync --frozen --extra dev
  docker exec -i prumo-screening-pg psql -U postgres -d prumo_screening_a < "$WT/backend/tests/integration/supabase_stub.sql"
  cd "$WT/backend" && uv run alembic upgrade head && uv run python -m app.seed
  ```
  Port 55432 is taken by another project's container; use 55433. If `docker run` fails in the sandbox, retry it unsandboxed.
- Run one file: `cd "$WT/backend" && uv run pytest tests/integration/test_x.py -q -p no:randomly`; a run without a `= N passed … =` summary line is inconclusive.

**Commands**
- Backend lint: `make -C "$WT" lint-backend` (ruff check + format check + mypy ratchet).
- Backend unit: `cd "$WT/backend" && uv run pytest tests/unit/<file> -q`.
- Frontend: `npx vitest run <path>` · `npm run test:run` · `npm run typecheck` · `npm run lint` · `npx knip --no-tag-hints` · `npx knip --production --no-tag-hints` (all from `$WT`).
- Fitness scripts need Python ≥ 3.11 and the system `python3` is 3.9, so always run them through uv: `cd "$WT/backend" && uv run python ../scripts/fitness/<name>.py` (names used here: `check_copy_keys`, `check_react_query_keys`, `check_frontend_data_path`, `check_scope_guards`, `check_layered_arch`, `check_api_response_envelope`, `check_response_descriptions`).
- Full gate before the PR: `make -C "$WT" quality-scan`.

## Spec-gate resolutions

Every slice-A item of `spec-gate.md`, by number. Slice-B items: #9, #20, #21, #22, #23 and the slice-B halves of #27, #31, #34 are deferred to the slice-B plan.

| # | Decision | Task |
|---|---|---|
| 1 | Import role = membership via `require_project_scope` (`backend/app/api/deps/security.py:161`), which runs `public.is_project_member` — the same SQL as Zotero's `_assert_project_member` (`backend/app/api/v1/endpoints/zotero_import.py:76-86`). Enqueue after commit, as Zotero does (`zotero_import.py:178-203`). The project-path poll route is new. | 4 |
| 2 | Poll binds project and requester in ONE WHERE clause: `ArticleSyncRunRepository.get_owned_run(sync_run_id, user_id, *, project_id=None)` (`backend/app/repositories/article_repository.py:200-207`) gains `ArticleSyncRun.project_id == project_id` when given (precedent: `owned_batch(..., project_id=None)`, `backend/app/services/extraction_batch_service.py:90-103`), plus `require_project_scope` on the path project. Missing, foreign-project and other-requester runs are one 404. | 4 |
| 3 | `get_by_canonical_identity` keeps the `zotero_item_key` short-circuit (`article_repository.py:99-100`), then ordered lookups pmid → doi → url_landing, one query each, first hit wins. | 3 |
| 4 | DOI match: the normalized input DOI is compared with `regexp_replace(lower(btrim(articles.doi)), '^(https?://(dx\.)?doi\.org/\|doi:\s*)', '')` within the project. No DDL on `articles`. Tests cover `https://doi.org/`, `http://dx.doi.org/`, `doi:` and mixed-case stored values. | 3 |
| 5 | `source_payload = {"efetch_xml": "<PubmedArticle>…</PubmedArticle>"}` — the record's XML fragment under the key `efetch_xml`. | 2 |
| 6 | `papaparse@5.7.0` (released 2026-08-24) exact in `dependencies`, `@types/papaparse@5.5.2` exact in `devDependencies` (5.7.0 ships no types). knip both modes at zero; `npm audit --omit=dev --audit-level=high` stays green (`.github/workflows/security-audit.yml:59`). | 10 |
| 7 | Posture = 0091's (`backend/alembic/versions/0091_ai_usage_ledger.py:107-109`) on all three tables: `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY "deny_all" … FOR ALL USING (false)`, `REVOKE ALL … FROM "authenticated", "anon"`. Privilege + PostgREST-role tests mirror `backend/tests/integration/test_ai_usage_ledger.py:76-130`. | 1 |
| 8 | `0094` runs `REVOKE INSERT, UPDATE, DELETE ON article_sync_runs, article_sync_events FROM anon, authenticated`; downgrade re-grants `INSERT, UPDATE, DELETE` to `authenticated` only (restores the baseline grant, `baseline_v1.sql:3001-3007`). SELECT is untouched. | 1 |
| 10 | `PUBMED_IMPORT_LOCK = UUID("e2d0f3dc-4692-406e-bcaa-5df90c43fcf6")` lives in `backend/app/services/pubmed_import_service.py` beside its only user (precedent `AGENT_CAP_LOCK`, `extraction_batch_service.py:39`); one constant per purpose (`SCREENING_AI_RUN_LOCK` belongs to slice B's service). The task commits once per batch, so each `take_advisory_xact_lock(db, project_id, PUBMED_IMPORT_LOCK)` (`backend/app/services/advisory_locks.py:16`) covers exactly one batch's lookup-and-upsert. NCBI calls happen outside the lock. | 4 |
| 11 | Ruling: accepted for v1. `articles` stays member-writable through PostgREST; the PR body states it as a known limitation (a member can relabel an article's source and skew the "other sources" line). The PubMed line reads closed sync events and is unaffected. | Verification |
| 12 | A PMID is "not retrieved" when none of its `pubmed` events has status `inserted` or `updated` (`duplicate_in_request` events repeat the first occurrence and never decide). Status only — a deleted article (event `article_id` → NULL) does not move its PMID into "not retrieved". | 8 |
| 13 | Run counts: `total_received` = PMIDs received (repeats included), `persisted` = `inserted`, `updated` = `updated`, `skipped` = `duplicate_in_request`, `failed` = `not_found` + `failed`; recomputed from the run's events after every batch. Status `pending` → `running` → `completed` when the task finishes; `failed` only when the task aborts or the enqueue fails. | 4 |
| 14 | Chosen: idempotent resume. The task skips PMIDs that already have an event in this run and recomputes counts from events, so a redelivered task (`task_acks_late`, `backend/app/worker/celery_app.py:40-41`) writes nothing twice; the task also has `max_retries=0` and no `self.retry`. Test: running the same run twice leaves one event per received PMID and identical counts. | 4 |
| 15 | Non-dry-run import probes `queue_health.is_queue_available()` (`backend/app/worker/queue_health.py:10`) before creating the run; unavailable → 503 `SERVICE_UNAVAILABLE`, nothing written. | 4 |
| 16 | Authors: PubMed writes `articles.authors` (`Last, Initials`) on insert only and writes no `article_author_links` (`creator_rows=[]`). Zotero writes links through `_sync_author_links` → `replace_article_links` (`backend/app/services/zotero_import_service.py:396`, `:494-525`), which REPLACES a matched article's links, and nothing in `backend/app` or `frontend` reads links. On a match `authors` is untouched (it is not in §4.2's fill list). | 2, 3 |
| 17 | Schema fully specified in Task 1: FKs `project_id`/`article_id`/`assignment_id` CASCADE, `enrolled_by` → profiles SET NULL, `reviewer_id`/`decided_by` → profiles RESTRICT (as `extraction_reviewer_decisions`/`extraction_consensus_decisions`, `baseline_v1.sql:1867`, `:2042`), `selected_decision_id` → screening_decisions SET NULL (as `baseline_v1.sql:1887`); `text` + CHECK for kinds; CHECK `exclusion_reason IS NULL OR decision = 'exclude'`; INSERT-only through 0081's `refuse_append_only_change` trigger (`0081_revoke_member_writes.py:76-95`) on decisions and arbitrations; ORM models match so `alembic check` is clean. | 1 |
| 18 | Head pin `expected_head` (`backend/tests/integration/test_migration_roundtrip.py:1335`) → `0094_screening_v1`; new `test_migration_0094_screening_v1_roundtrip` (tables, posture, triggers, sync-table grants down and back up). | 1 |
| 19 | Ruling: `NCBI_EMAIL: str \| None = None` in Settings (app boots without it); a non-dry-run import refuses with 503 `NCBI_EMAIL_NOT_CONFIGURED` before creating a run; dry run needs no email. `backend/.env.example` documents it; setting it on Railway (backend + worker) is a human step flagged in the PR. | 2, 4 |
| 24 | Ruling: an arbitrator may rule a conflict they reviewed (extraction precedent: `ensure_project_arbitrator` with no self-exclusion). Tested. | 7 |
| 25 | `PUT …/screening/config`: `reviewer_count` outside 1..3 → 422 (schema); above `ProjectMemberRepository.count_reviewer_capable` (`backend/app/repositories/project_repository.py:73-83`) → 409 `SCREENING_TOO_FEW_REVIEWERS`; a different value once the project has any decision → 409 `SCREENING_CONFIG_FROZEN`; the same value → 200 no-op. | 5 |
| 26 | Ruling: enroll-all enrolls every project article not yet enrolled, `sync_state = removed_at_source` included. Tested. | 5 |
| 27 | `load_assignment_for_member` returns the schema `ScreeningAssignmentRef` (as `load_run_for_member`, `backend/app/api/deps/scope.py:39-54`). `.claude/rules/backend.md` § Ownership guards gains both new guards (Task 6: by-id assignment; Task 7: `owned_decisions`). `assignment_id` joins `SCOPE_COLUMNS` (`scripts/fitness/check_scope_guards.py:53-63`) with a canary. The AI-kickoff shape note is slice B. | 6, 7 |
| 28 | `ProjectView` renders `ScreeningTab` and `PrismaCountsPanel` instead of `ComingSoonPanel` (`frontend/pages/ProjectView.tsx:250-254`); `comingSoon` removed (`frontend/components/layout/sidebarConfig.ts:54`, `:57`); `frontend/lib/copy/screening.ts` registered in `frontend/lib/copy/index.ts`; the articles source filter gains `PUBMED` (comparison is already upper-cased, `frontend/components/articles/ArticlesList.tsx:594-598`). The PubMed dialog mounts in the Screening tab (header + empty state). | 9, 10, 13 |
| 29 | Playwright gets `SCREENING_PROJECT_ID` (own project, owner manager + reviewers B and C, two seeded articles). Rerunnable: `beforeAll` deletes the project's articles through the service role (FK cascades remove every screening row as the table owner) and resets `projects.settings` to `{}`, then recreates the articles. | 13 |
| 30 | `PubmedImportRequest.pmids`: `min_length=1`, `max_length=10_000`, each item matches `^[0-9]{1,10}$` → 422 otherwise. | 4 |
| 31 | Screening tab states enumerated with copy keys and tests: loading, load error, viewer, non-manager unconfigured, non-manager nothing enrolled, manager configure, manager enroll, queue, waiting on peers vs done, conflicts (arbitrators), assignment 404/403, each 409 (`SCREENING_CONFIG_FROZEN`, `SCREENING_TOO_FEW_REVIEWERS`, `SCREENING_NOT_CONFIGURED`, `SCREENING_REVIEWER_CAP`, `SCREENING_UNKNOWN_EXCLUSION_REASON`, `SCREENING_NOT_IN_CONFLICT`, `SCREENING_STALE_DECISIONS`). | 9, 11, 12 |
| 32 | PRISMA tab states: loading, empty (nothing enrolled), error, forbidden, counts. | 13 |
| 33 | Import dialog states: no PMID column, invalid PMIDs, > 10,000, > 25 MB, zero PMIDs, BOM/quoted header, dry-run error, zero new, queue unavailable, NCBI email missing, running, completed with not-found/failed, run failed, poll 404, completion → enroll next step. | 10 |
| 34 | Every slice-A requirement listed there gets a named test — see the table in **Verification**. | all |
| 35 | 13 tasks (8 backend, 5 frontend), dependency-ordered. Deviation from the suggested split: the Screening tab shell (Task 9) precedes the import dialog (Task 10) so each frontend task mounts what it builds and keeps `knip --production` at zero. | — |

## Review Focus

Inputs the spec implies but its §12 never names, most likely first; each line's test lives in the owning task.

1. A PubMed CSV that starts with a UTF-8 BOM and quotes its header (`"PMID"`) → the PMID column is found (Task 10, `parsePmidCsv finds a BOM-prefixed quoted PMID header`).
2. A PMID repeated in one request whose first occurrence is not found → one `not_found` + one `duplicate_in_request` event, counted as not retrieved, never as a duplicate (Task 4 `test_run_import_writes_one_event_per_received_pmid`; Task 8 `test_not_found_pmids_are_not_duplicates`).
3. A manager edits the protocol and removes an exclusion reason after a reviewer loaded the queue → the decision answers 409 `SCREENING_UNKNOWN_EXCLUSION_REASON` and the UI says the reasons changed (Task 6 `test_unknown_exclusion_reason_is_refused`; Task 11 `shows the reasons-changed message on SCREENING_UNKNOWN_EXCLUSION_REASON`).
4. A manager deletes an enrolled article through PostgREST while it is in someone's queue → screening rows cascade despite the append-only trigger and the revoked grants; opening the assignment answers 404 (Task 1 `test_manager_deleting_an_enrolled_article_cascades_screening_rows`; Task 6 `test_deleted_article_assignment_is_404`; Task 11 `renders not-found for a missing assignment`).
5. Titles and abstracts with inline markup (`<i>`, `<sup>`) and non-ASCII author names → text joined from `itertext()`, names preserved (Task 2 `test_markup_and_non_ascii_survive`).

---

## Tasks

### Task 1: Migration `0094_screening_v1`, ORM models, posture tests, head pin

**Seat:** backend · **Depends on:** nothing

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Model change ⇒ this migration in this task; draft with `uv run alembic revision --autogenerate -m "screening v1"` then hand-edit; revision id ≤ 32 chars; `alembic check` clean. The `ck` naming convention (`backend/app/models/base.py:134-144`) expands a SHORT CHECK name to `ck_<table>_<name>` — pass the short name to both `CheckConstraint` and the migration. No seed data in migrations. Integration tests run on the dedicated DB below — never `make db-fresh`/`reset-db`, never upgrade the shared Supabase DB. The post-edit hook strips unused imports: add each import in the edit that first uses it. Vulture is shrink-only.

**Test DB bootstrap (do it first, once):**
```bash
docker start prumo-screening-pg 2>/dev/null || docker run -d --name prumo-screening-pg -p 55433:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres postgres:17
docker exec prumo-screening-pg psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='prumo_screening_a'" | grep -q 1 || docker exec prumo-screening-pg psql -U postgres -c "CREATE DATABASE prumo_screening_a"
cat > "$WT/backend/.env" <<'ENV'
DATABASE_URL=postgresql://postgres:postgres@localhost:55433/prumo_screening_a
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=stub-service-role
SUPABASE_ENV=local
OPENAI_API_KEY=sk-test-not-real
NCBI_EMAIL=dev@prumo.test
ENV
cd "$WT/backend" && uv sync --frozen --extra dev
docker exec -i prumo-screening-pg psql -U postgres -d prumo_screening_a < "$WT/backend/tests/integration/supabase_stub.sql"
cd "$WT/backend" && uv run alembic upgrade head && uv run python -m app.seed
```
(`backend/.env` is gitignored; never commit it. Retry `docker run` unsandboxed if the sandbox refuses it.)

**Files:**
- Create: `backend/alembic/versions/0094_screening_v1.py`
- Create: `backend/app/models/screening.py`
- Modify: `backend/app/models/__init__.py` (import beside `AiUsageLedger` at :16; add the three names to `__all__` at :109)
- Create: `backend/tests/integration/test_screening_schema.py`
- Modify: `backend/tests/integration/test_migration_roundtrip.py:1335` (head pin) and append a 0094 case after the 0093 case (:2708)

**Interfaces:**
- Produces (`backend/app/models/screening.py`): `SCREENING_PHASE = "title_abstract"`, `SCREENING_DECISIONS = ("include", "exclude", "maybe")`; ORM classes on `Base, UUIDMixin` (as `backend/app/models/ai_usage_ledger.py:21`):
  - `ScreeningAssignment` (`screening_assignments`): `project_id: UUID`, `article_id: UUID`, `phase: str` (default `SCREENING_PHASE`), `enrolled_at: datetime` (server default `now()`), `enrolled_by: UUID | None`.
  - `ScreeningDecision` (`screening_decisions`): `assignment_id: UUID`, `reviewer_id: UUID`, `decision: str`, `exclusion_reason: str | None`, `rationale: str | None`, `created_at: datetime` (server default `now()`).
  - `ScreeningArbitration` (`screening_arbitrations`): `assignment_id: UUID`, `decision: str`, `exclusion_reason: str | None`, `selected_decision_id: UUID | None`, `rationale: str | None`, `decided_by: UUID`, `created_at: datetime`.
- Later tasks rely on these exact names and on the DB-side `id` default (`gen_random_uuid()`), which `INSERT … SELECT` in Task 5 needs.

**Schema (exact):**

| Table | Column | Type / constraint |
|---|---|---|
| `screening_assignments` | `id` | uuid PK, server default `gen_random_uuid()` |
| | `project_id` | uuid NOT NULL → `projects.id` ON DELETE CASCADE (`screening_assignments_project_id_fkey`) |
| | `article_id` | uuid NOT NULL → `articles.id` ON DELETE CASCADE |
| | `phase` | text NOT NULL default `'title_abstract'`, CHECK short name `phase`: `phase IN ('title_abstract')` |
| | `enrolled_at` | timestamptz NOT NULL default `now()` (one statement's rows share it) |
| | `enrolled_by` | uuid NULL → `profiles.id` ON DELETE SET NULL |
| | unique | `uq_screening_assignments_article_phase` (`project_id`, `article_id`, `phase`) |
| `screening_decisions` | `id` | uuid PK default `gen_random_uuid()` |
| | `assignment_id` | uuid NOT NULL → `screening_assignments.id` ON DELETE CASCADE |
| | `reviewer_id` | uuid NOT NULL → `profiles.id` ON DELETE RESTRICT |
| | `decision` | text NOT NULL, CHECK `decision`: `decision IN ('include', 'exclude', 'maybe')` |
| | `exclusion_reason` | text NULL, CHECK `reason_on_exclude`: `exclusion_reason IS NULL OR decision = 'exclude'` |
| | `rationale` | text NULL |
| | `created_at` | timestamptz NOT NULL default `now()` |
| | index | `ix_screening_decisions_current` (`assignment_id`, `reviewer_id`, `created_at DESC`, `id DESC`) |
| `screening_arbitrations` | `id`, `assignment_id`, `decision`, `exclusion_reason`, `rationale`, `created_at` | as in `screening_decisions` (same CHECK short names) |
| | `selected_decision_id` | uuid NULL → `screening_decisions.id` ON DELETE SET NULL |
| | `decided_by` | uuid NOT NULL → `profiles.id` ON DELETE RESTRICT |
| | index | `ix_screening_arbitrations_current` (`assignment_id`, `created_at DESC`, `id DESC`) |

FK constraint names follow `<table>_<column>_fkey` and are passed explicitly (as `0091_ai_usage_ledger.py:32-40`). In the ORM, declare the two DESC indexes after each class as `Index("ix_…", Cls.assignment_id, …, Cls.created_at.desc(), Cls.id.desc())`; in the migration `op.create_index(..., [..., sa.text("created_at DESC"), sa.text("id DESC")])`.

Migration body, in order: create the three tables and indexes; for each table `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `CREATE POLICY "deny_all" ON … FOR ALL USING (false)`, `REVOKE ALL ON … FROM "authenticated", "anon"` (0091:107-109); `CREATE TRIGGER refuse_append_only_change BEFORE UPDATE OR DELETE ON public.screening_decisions` and `… ON public.screening_arbitrations` `FOR EACH ROW EXECUTE FUNCTION public.refuse_append_only_change()` (function from 0081:76-90; do not recreate it); `REVOKE INSERT, UPDATE, DELETE ON "public"."article_sync_runs", "public"."article_sync_events" FROM "anon", "authenticated"`. Downgrade: `GRANT INSERT, UPDATE, DELETE ON` both sync tables `TO "authenticated"` (only — anon never had a migration grant), then drop arbitrations, decisions, assignments. Docstring: why backend-only (blind review: member-read RLS would reopen the leak `0025` closed), why INSERT-only (constitution §IX), why the sync-table revoke (PRISMA reads those rows; nothing in `frontend/` writes them — `grep -rn article_sync frontend` outside generated types is empty).

- [ ] **Step 1: Write the failing schema tests** in `backend/tests/integration/test_screening_schema.py`. Reuse the probe shape of `_as_manager` (`backend/tests/integration/test_ai_usage_ledger.py:76-97`: commit, `set_config('request.jwt.claims', …)` with `SEED.primary_profile`, `SET LOCAL ROLE authenticated`, return error text or scalar, roll back). Build rows with the ORM classes so the tests also prove the mapping; create articles with `make_article` (`backend/tests/integration/helpers/batch_fixtures.py:12`) in `SEED.primary_project`.

```python
SCREENING = ["screening_assignments", "screening_decisions", "screening_arbitrations"]
SYNC = ["article_sync_runs", "article_sync_events"]

@pytest.mark.parametrize("table", SCREENING)
@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("privilege", ["SELECT", "INSERT", "UPDATE", "DELETE"])
async def test_screening_tables_are_deny_all(db_session, table, role, privilege):
    # has_table_privilege(role, 'public.<table>', privilege) is False

@pytest.mark.parametrize("table", SYNC)
@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("privilege", ["INSERT", "UPDATE", "DELETE"])
async def test_sync_tables_refuse_client_writes(db_session, table, role, privilege):
    # False

@pytest.mark.parametrize("table", SYNC)
async def test_sync_tables_keep_member_select(db_session, table):
    # has_table_privilege('authenticated', 'public.<table>', 'SELECT') is True  (positive pairing)

@pytest.mark.parametrize("table", SCREENING)
async def test_screening_read_as_authenticated_is_permission_denied(db_session, table):
    # _as_manager(db, f"SELECT count(*) FROM public.{table}") contains "permission denied"
    # and, same probe, "SELECT count(*) FROM public.articles WHERE project_id = :pid" returns an int ≥ 1

async def test_deny_all_policy_hides_rows_even_with_grant(db_session):
    # insert an assignment as owner, commit; regrant SELECT inside the probe → count == 0

@pytest.mark.parametrize("table", ["screening_decisions", "screening_arbitrations"])
@pytest.mark.parametrize("op", ["update", "delete"])
async def test_append_only_trigger_refuses_non_owner(db_session, table, op):
    # precedent backend/tests/integration/test_member_write_grants_revoked.py:325-351:
    # GRANT UPDATE, DELETE ON public.<table> TO service_role; SET LOCAL ROLE service_role;
    # UPDATE … SET rationale = 'x' / DELETE … → DBAPIError match "append-only table"

@pytest.mark.parametrize("model", ["decision", "arbitration"])
async def test_exclusion_reason_only_on_exclude(db_session, model):
    # decision='include', exclusion_reason='Wrong population' → IntegrityError whose text names
    #   ck_screening_decisions_reason_on_exclude / ck_screening_arbitrations_reason_on_exclude
    # decision='exclude' with and without a reason → flush succeeds

async def test_decision_value_is_checked(db_session):
    # decision='skip' → IntegrityError naming ck_screening_decisions_decision

async def test_one_assignment_per_article_and_phase(db_session):
    # second ScreeningAssignment for the same (project, article) → IntegrityError naming
    #   uq_screening_assignments_article_phase

async def test_manager_deleting_an_enrolled_article_cascades_screening_rows(db_session):
    # article + assignment + 2 decisions + arbitration with selected_decision_id = first decision; commit;
    # probe as the manager JWT: "DELETE FROM public.articles WHERE id = :aid" → rowcount 1;
    # inside the same transaction RESET ROLE, then counts of the three tables for that assignment == 0
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/integration/test_screening_schema.py -q -p no:randomly`
Expected: errors — `ModuleNotFoundError: No module named 'app.models.screening'`.

- [ ] **Step 3: Write the ORM models and export them** (`backend/app/models/screening.py`, `backend/app/models/__init__.py`), exactly the schema table above, `__table_args__` ending with `{"schema": "public"}`, CHECKs with the short names, `ForeignKey("public.<table>.id", ondelete=…)`.

- [ ] **Step 4: Write `0094_screening_v1.py`** (`revision = "0094_screening_v1"`, `down_revision = "0093_batch_agent_origin"`), body as above. Apply and check:

Run: `cd "$WT/backend" && uv run alembic upgrade head && uv run alembic check`
Expected: `No new upgrade operations detected.` (If `check` reports the DESC indexes, make the ORM and migration expressions identical; do not suppress.)

Run: `cd "$WT/backend" && uv run alembic upgrade 0093_batch_agent_origin:0094_screening_v1 --sql | grep -c 'deny_all'`
Expected: `3`

- [ ] **Step 5: Run the schema tests**

Run: `cd "$WT/backend" && uv run pytest tests/integration/test_screening_schema.py -q -p no:randomly`
Expected: `51 passed` (24 + 12 + 2 + 3 + 1 + 4 + 2 + 1 + 1 + 1), zero failures.

- [ ] **Step 6: Move the head pin and add the roundtrip test** in `test_migration_roundtrip.py`: `expected_head = "0094_screening_v1"`; new `test_migration_0094_screening_v1_roundtrip(migration_db_url, migration_session)` modelled on `test_migration_0091_ai_usage_ledger_roundtrip` (:2527-2598) using `_run_alembic` (:102):

```python
# at head: the three tables exist with relrowsecurity, policies == {"deny_all"} each,
#   triggers named refuse_append_only_change on decisions and arbitrations,
#   has_table_privilege('authenticated', 'public.article_sync_runs', 'INSERT') is False
# downgrade 0093_batch_agent_origin: to_regclass of each table is NULL;
#   authenticated INSERT/UPDATE/DELETE on both sync tables are True; anon INSERT on article_sync_runs is False
# upgrade head again: the head posture is back, including authenticated SELECT on screening tables False
```

Run: `cd "$WT/backend" && uv run pytest tests/integration/test_migration_roundtrip.py -q -p no:randomly -k "0094 or expected_revision or chain_is_continuous"`
Expected: 3 passed.

- [ ] **Step 7: Gates and commit**

Run: `make -C "$WT" lint-backend && cd "$WT/backend" && uv run python ../scripts/vulture_baseline.py --baseline .vulture_baseline --exec`
Expected: both exit 0.

```bash
git -C "$WT" add backend/alembic/versions/0094_screening_v1.py backend/app/models/screening.py backend/app/models/__init__.py backend/tests/integration/test_screening_schema.py backend/tests/integration/test_migration_roundtrip.py
git -C "$WT" commit -m "feat(screening): add 0094 backend-only screening tables and close sync-table writes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: `NCBI_EMAIL`, PubMed `efetch` client, `normalize_pubmed_record`, fixtures

**Seat:** backend · **Depends on:** nothing (Task 1 only for the shared test DB, which this task does not use)

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Settings are typed fields in `backend/app/core/config.py`, never `os.getenv`; tests assert `Settings.model_fields["X"].default`, never the `settings` singleton. No new Python dependency: parse XML with stdlib `xml.etree.ElementTree` (the bundled expat ≥ 2.4.1 refuses entity-expansion bombs, and ElementTree never fetches external DTDs). The post-edit hook strips unused imports: add each import in the edit that first uses it. Vulture is shrink-only: every new public symbol in `app/` must have an `app/` caller by the end of Task 4 — `PubMedClient`, `PubMedFetchError`, `EFETCH_BATCH_SIZE` and `normalize_pubmed_record` are consumed there.

**Files:**
- Modify: `backend/app/core/config.py` (new `# =================== NCBI (PubMed E-utilities) ===================` block just above `FEEDBACK / LINEAR`, :268): `NCBI_EMAIL: str | None = None` with a comment "sent as `email` with `tool=prumo` on every E-utilities call; a non-dry-run PubMed import refuses while unset".
- Modify: `backend/.env.example` (after `ENCRYPTION_KEY`): a commented `# NCBI_EMAIL=you@example.org` with the same one-line explanation.
- Create: `backend/app/services/pubmed_client.py`
- Modify: `backend/app/services/article_source_normalization.py` (after `normalize_zotero_item`, :59-110)
- Create: `backend/tests/fixtures/pubmed/efetch_batch.xml` (captured, never hand-edited)
- Create: `backend/tests/unit/test_pubmed_client.py`
- Modify: `backend/tests/unit/test_article_source_normalization.py`

**Interfaces:**
- Consumes: `normalize_doi` (`article_source_normalization.py:19-23`), `extract_year` (:33-39), `CanonicalArticlePayload` (:52-56).
- Produces (`backend/app/services/pubmed_client.py`):
  - `EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"`, `EFETCH_BATCH_SIZE = 200`, `MIN_REQUEST_INTERVAL_S = 0.34` (≤ 3 req/s, NCBI's limit without a key).
  - `class PubMedFetchError(Exception)`.
  - `class PubMedClient`: `__init__(self, *, email: str, transport: httpx.AsyncBaseTransport | None = None, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, clock: Callable[[], float] = time.monotonic, timeout_s: float = 30.0)` — a blank or `None` email raises `ValueError` (NCBI etiquette is mandatory, spec §4.1); `async def efetch(self, pmids: Sequence[str]) -> dict[str, xml.etree.ElementTree.Element]` — one GET of `EFETCH_URL` with params `db=pubmed`, `retmode=xml`, `tool=prumo`, `email=<email>`, `id=",".join(pmids)`; waits until `MIN_REQUEST_INTERVAL_S` has passed since its previous request (instance-level, via `clock`/`sleep`); returns `{MedlineCitation/PMID text: <PubmedArticle> element}` for each `PubmedArticle` child of the root (absent PMIDs are simply missing); `[]` → `{}` with no request; more than `EFETCH_BATCH_SIZE` ids → `ValueError`; any `httpx.HTTPError`, non-200 status or `ET.ParseError` → `PubMedFetchError`.
- Produces (`article_source_normalization.py`): `PUBMED_SOURCE = "pubmed"`; `def normalize_pubmed_record(*, record: ET.Element) -> CanonicalArticlePayload` where `record` is one `<PubmedArticle>`:
  - `canonical_identity = {"pmid": pmid, "doi": doi, "url_landing": None}`; `creator_rows = []` (spec-gate #16: PubMed writes no author links).
  - `article_fields`: `title` (`"".join(ArticleTitle.itertext()).strip()`, fallback `"Untitled"`), `abstract` (each `Abstract/AbstractText` as `itertext` joined and stripped; a part with `Label` becomes `"LABEL: text"`; parts joined with `"\n\n"`; no non-empty part → `None`), `authors` (`"Last, Initials"`, `"Last"` without initials, `CollectiveName` verbatim; `None` when empty), `journal_title` (`Journal/Title`), `publication_year` (`PubDate/Year`, else `extract_year(PubDate/MedlineDate)`), `publication_month` (`PubDate/Month`: `"Jan"`…`"Dec"` or `"1"`…`"12"` → int, else `None`), `publication_day` (`PubDate/Day` → int or `None`), `volume`, `issue` (`JournalIssue/Volume`, `/Issue`), `pages` (`Pagination/MedlinePgn`), `doi` (`normalize_doi` of `ELocationID[@EIdType='doi']`, else of `PubmedData/ArticleIdList/ArticleId[@IdType='doi']`), `pmid`, `pmcid` (`PubmedData/ArticleIdList/ArticleId[@IdType='pmc']` — the DIRECT child list only, never `ReferenceList/…/ArticleIdList`), `mesh_terms` (`MeshHeadingList/MeshHeading/DescriptorName` texts or `None`), `keywords` (`KeywordList/Keyword` texts or `None`), `article_type` (first `PublicationTypeList/PublicationType`), `language` (first `Article/Language`), `ingestion_source = "pubmed"`, `source_lineage = "pubmed"`, `source_payload = {"efetch_xml": ET.tostring(record, encoding="unicode")}` (spec-gate #5).

- [ ] **Step 1: Capture the fixture** (real NCBI response; 49999999 is a PMID that does not exist, so it is absent):

```bash
mkdir -p "$WT/backend/tests/fixtures/pubmed"
curl -sf "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=42908551,42875467,42706533,49999999&retmode=xml&tool=prumo&email=dev@prumo.test" -o "$WT/backend/tests/fixtures/pubmed/efetch_batch.xml"
grep -c '<PubmedArticle>' "$WT/backend/tests/fixtures/pubmed/efetch_batch.xml"   # expect 3
```
The expected literals below were read from this response on 2026-10-23. If NCBI has revised a record since, update the literal from the captured file and say so in the commit message — never edit the XML.

- [ ] **Step 2: Write the failing tests.** In `test_article_source_normalization.py` (fixture parsed with `ET.parse(Path(__file__).parents[1] / "fixtures/pubmed/efetch_batch.xml")`, records looked up by PMID):

```python
def test_structured_abstract_record():  # PMID 42908551
    p = normalize_pubmed_record(record=rec("42908551"))
    f = p.article_fields
    assert f["title"].startswith("Development and validation of an interpretable machine learning model")
    assert f["abstract"].startswith("BACKGROUND: Acute kidney injury (AKI) and altered consciousnes")
    assert "\n\nMETHODS: We retrospectively extracted data from the MIMIC-I" in f["abstract"]
    assert "\n\nRESULT: " in f["abstract"] and "\n\nCONCLUSION: " in f["abstract"]
    assert f["authors"][0] == "Yang, S" and len(f["authors"]) == 6
    assert (f["journal_title"], f["volume"], f["issue"], f["pages"]) == ("Frontiers in endocrinology", "17", None, "1959304")
    assert (f["publication_year"], f["publication_month"], f["publication_day"]) == (2026, None, None)
    assert f["doi"] == "10.3389/fendo.2026.1959304" and f["pmid"] == "42908551" and f["pmcid"] == "PMC13682982"
    assert len(f["mesh_terms"]) == 14 and f["mesh_terms"][0] == "Humans"
    assert f["keywords"] == ["acute kidney injury", "altered consciousness", "cardiac surgery", "intensive care unit", "machine learning"]
    assert (f["article_type"], f["language"]) == ("Journal Article", "eng")
    assert (f["ingestion_source"], f["source_lineage"]) == ("pubmed", "pubmed")
    assert set(f["source_payload"]) == {"efetch_xml"}
    assert f["source_payload"]["efetch_xml"].startswith("<PubmedArticle>")
    assert '<PMID Version="1">42908551</PMID>' in f["source_payload"]["efetch_xml"]
    assert p.canonical_identity == {"pmid": "42908551", "doi": "10.3389/fendo.2026.1959304", "url_landing": None}
    assert p.creator_rows == []

def test_unstructured_abstract_and_own_pmc_only():  # PMID 42875467 (its ReferenceList carries other PMC ids)
    f = normalize_pubmed_record(record=rec("42875467")).article_fields
    assert f["abstract"].startswith("Patients with multiple myeloma accumulate hundreds") and ":" not in f["abstract"][:12]
    assert f["pmcid"] == "PMC13669396"
    assert (f["publication_month"], f["publication_day"], f["issue"]) == (10, 14, "1")
    assert f["mesh_terms"] is None and f["keywords"] is None and f["pages"] is None
    assert len(f["authors"]) == 24

def test_letter_without_abstract():  # PMID 42706533
    f = normalize_pubmed_record(record=rec("42706533")).article_fields
    assert f["abstract"] is None and f["article_type"] == "Letter" and f["publication_month"] == 9
    assert f["doi"] == "10.1186/s13054-026-06289-y"

def test_markup_and_non_ascii_survive():  # inline XML: <ArticleTitle>A <i>BRCA1</i> study</ArticleTitle>,
    # <AbstractText>CRP<sup>2</sup> rose</AbstractText>, Author LastName "Lübberstedt" Initials "J"
    # → title "A BRCA1 study", abstract "CRP2 rose", authors ["Lübberstedt, J"]

@pytest.mark.parametrize(("pubdate", "expected"), [
    ("<Year>2023</Year><Month>Mar</Month><Day>07</Day>", (2023, 3, 7)),
    ("<Year>2023</Year><Month>03</Month>", (2023, 3, None)),
    ("<MedlineDate>2023 Jan-Feb</MedlineDate>", (2023, None, None)),
    ("<Year>2023</Year><Season>Spring</Season>", (2023, None, None)),
], ids=["named-month", "numeric-month", "medline-date", "season"])
def test_pubdate_variants(pubdate, expected): ...

def test_collective_author_and_doi_from_article_id_list():  # inline XML: <CollectiveName>MIMIC-IV Investigators</CollectiveName>,
    # no ELocationID, PubmedData ArticleId IdType="doi" "10.1/ABC" → authors ["MIMIC-IV Investigators"], doi "10.1/abc"
```

In `test_pubmed_client.py` (all over `httpx.MockTransport`, fixture bytes as the body):

```python
async def test_efetch_sends_etiquette_and_ids():
    # request.url.params: db=pubmed, retmode=xml, tool=prumo, email=dev@prumo.test,
    #   id="42908551,42875467,42706533,49999999"; result keys == {"42908551", "42875467", "42706533"}

async def test_efetch_spaces_requests_at_most_three_per_second():
    # fake clock + fake sleep (sleep advances the clock); three efetch calls;
    # the clock values recorded by the handler differ pairwise by ≥ MIN_REQUEST_INTERVAL_S

async def test_efetch_refuses_more_than_one_batch():  # 201 ids → ValueError, no request sent
async def test_efetch_empty_sends_nothing():          # [] → {} and the handler is never called
@pytest.mark.parametrize("failure", ["status_500", "connect_error", "not_xml"])
async def test_efetch_failures_raise_fetch_error(failure): ...  # → PubMedFetchError

@pytest.mark.parametrize("email", ["", "  ", None], ids=["empty", "blank", "none"])
def test_client_requires_an_email(email):  # PubMedClient(email=email) raises ValueError

def test_ncbi_email_is_optional():
    assert Settings.model_fields["NCBI_EMAIL"].default is None
```

- [ ] **Step 3: Run to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_pubmed_client.py tests/unit/test_article_source_normalization.py -q`
Expected: collection errors (`ImportError: cannot import name 'normalize_pubmed_record'`, `No module named 'app.services.pubmed_client'`).

- [ ] **Step 4: Implement** the setting, `.env.example` line, `pubmed_client.py` and `normalize_pubmed_record` per the Interfaces block.

- [ ] **Step 5: Run the tests**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_pubmed_client.py tests/unit/test_article_source_normalization.py -q`
Expected: all pass.

- [ ] **Step 6: Lint and commit** (vulture runs in Task 4, once the consumer exists)

Run: `make -C "$WT" lint-backend`
Expected: exit 0.

```bash
git -C "$WT" add backend/app/core/config.py backend/.env.example backend/app/services/pubmed_client.py backend/app/services/article_source_normalization.py backend/tests/fixtures/pubmed/efetch_batch.xml backend/tests/unit/test_pubmed_client.py backend/tests/unit/test_article_source_normalization.py
git -C "$WT" commit -m "feat(screening): add the PubMed efetch client and normalize_pubmed_record" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: PMID-first canonical identity and the fill-only upsert

**Seat:** backend · **Depends on:** Task 1 (test DB at head)

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. No DDL on `articles` (no new index, no migration). Repositories hold queries and `flush()`, never `commit()`; the field list is a service-level decision passed in. Scope (`project_id`) is in every WHERE clause. Raw SQL fragments use bound parameters, never f-strings. Integration tests run on `postgresql://postgres:postgres@localhost:55433/prumo_screening_a` through `$WT/backend/.env` (bootstrap: this plan file `$WT/docs/superpowers/plans/2026-10-23-screening-v1-ai-prescreen-a.md` § Global Constraints → Test database); never `make db-fresh`/`reset-db`. The post-edit hook strips unused imports: add each import in the edit that first uses it.

**Files:**
- Modify: `backend/app/repositories/article_repository.py` (`get_by_canonical_identity` :91-117; add two methods to `ArticleRepository`)
- Modify: `backend/app/services/article_source_normalization.py` (add `PUBMED_FILL_FIELDS`)
- Modify: `backend/tests/unit/test_article_repository.py` (class `TestGetByCanonicalIdentity`, :173-208)
- Create: `backend/tests/integration/test_article_canonical_identity.py`

**Interfaces:**
- Consumes: Zotero's call sites stay valid (`backend/app/services/zotero_import_service.py:353-358` passes `zotero_item_key`/`doi`/`url_landing` by keyword; `upsert_by_canonical_identity` :119-146 is unchanged and remains Zotero's path).
- Produces (`ArticleRepository`):
  - `async def get_by_canonical_identity(self, project_id: UUID, *, zotero_item_key: str | None = None, pmid: str | None = None, doi: str | None = None, url_landing: str | None = None) -> Article | None` — `zotero_item_key` given → `get_by_zotero_item_key` and return (unchanged short-circuit); else, in order, one query each, first hit wins: `Article.pmid == pmid`; `doi_match_key(Article.doi) == doi` where `doi` is already `normalize_doi`-ed; `Article.url_landing == url_landing`. Each query filters `Article.project_id == project_id` and orders `created_at ASC, id ASC`, `LIMIT 1`.
  - module-level `def doi_match_key(column: ColumnElement[str | None]) -> ColumnElement[str]` = `func.regexp_replace(func.lower(func.btrim(column)), r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "")` (spec-gate #4).
  - `async def existing_pmids(self, project_id: UUID, pmids: Sequence[str]) -> set[str]` — the subset of `pmids` stored as `articles.pmid` in the project (one `IN` query; `[]` → `set()` without a query).
  - `async def fill_only_upsert(self, *, project_id: UUID, payload: dict[str, Any], canonical_identity: dict[str, str | None], fill_fields: Sequence[str]) -> tuple[Article, bool]` — match via `get_by_canonical_identity(project_id, pmid=…, doi=…, url_landing=…)`; on a match set only `fill_fields` whose current value is blank (`None`, a `str` whose `strip()` is `""`, or an empty list) to the payload's non-blank value, touch nothing else (never `ingestion_source`, `source_payload`, `source_lineage`, `zotero_*`, `last_synced_at`), flush, return `(article, False)`; no match → `Article(project_id=project_id, last_synced_at=now(UTC), **payload)` through `self.create`, return `(article, True)`.
- Produces (`article_source_normalization.py`): `PUBMED_FILL_FIELDS = ("abstract", "mesh_terms", "pmid", "pmcid", "keywords", "article_type", "language", "volume", "issue", "pages")` — exactly §4.2's list; `authors` is deliberately absent (spec-gate #16).

- [ ] **Step 1: Write the failing integration tests** in `backend/tests/integration/test_article_canonical_identity.py` (`db_session`; articles built with the ORM `Article` in `SEED.primary_project`, a foreign one in `SEED.secondary_project`, both from `tests.integration.conftest.SEED`):

```python
async def test_pmid_wins_over_doi(db_session):
    # A(pmid="111"), B(doi="10.1/x") → get_by_canonical_identity(P, pmid="111", doi="10.1/x") is A

async def test_falls_back_to_doi_then_url(db_session):
    # → (pmid="999", doi="10.1/x") is B; (pmid="999", url_landing=C.url_landing) is C; (pmid="999") is None

@pytest.mark.parametrize("stored", ["https://doi.org/10.1/ABC", "http://dx.doi.org/10.1/abc", "doi:10.1/ABC", " 10.1/Abc "],
                         ids=["https-prefix", "dx-prefix", "doi-colon", "case-and-space"])
async def test_doi_match_ignores_stored_prefix_and_case(db_session, stored):
    # article(doi=stored) is found by doi="10.1/abc"

async def test_zotero_key_short_circuits(db_session):
    # Z(zotero_item_key="K", pmid="111"), A(pmid="222") → (zotero_item_key="K", pmid="222") is Z

async def test_lookup_is_project_scoped(db_session):
    # article with pmid="333" in SEED.secondary_project → lookup in SEED.primary_project with pmid="333" is None

@pytest.mark.parametrize("source", ["zotero", "RIS"])
async def test_fill_only_upsert_fills_blanks_and_keeps_provenance(db_session, source):
    # existing: doi "https://doi.org/10.1/abc", ingestion_source=source, source_payload {"key": "K"}, source_lineage=source,
    #   zotero_item_key "K" if source == "zotero" else None, title "Kept title", volume "12",
    #   abstract "   ", mesh_terms None, keywords [], pmid None
    # payload: title "PubMed title", abstract "A", mesh_terms ["M"], keywords ["k"], pmid "111", volume "99",
    #   ingestion_source "pubmed", source_payload {"efetch_xml": "<x/>"}, source_lineage "pubmed"
    # fill_only_upsert(..., canonical_identity={"pmid": "111", "doi": "10.1/abc", "url_landing": None},
    #                  fill_fields=PUBMED_FILL_FIELDS) → created is False and the same article id
    # after: abstract "A", mesh_terms ["M"], keywords ["k"], pmid "111", volume "12", title "Kept title",
    #   ingestion_source == source, source_payload == {"key": "K"}, source_lineage == source
    # zotero case: the article is still in ArticleRepository(db).get_zotero_project_articles(P)

async def test_fill_only_upsert_inserts_on_no_match(db_session):
    # → created True; every payload field stored; last_synced_at is not None

async def test_existing_pmids(db_session):
    # articles with pmid "1" and "2" → existing_pmids(P, ["1", "3"]) == {"1"}; existing_pmids(P, []) == set()

def test_pubmed_fill_fields_are_the_spec_list():
    assert PUBMED_FILL_FIELDS == ("abstract", "mesh_terms", "pmid", "pmcid", "keywords",
                                  "article_type", "language", "volume", "issue", "pages")
```

In `test_article_repository.py` add `test_zotero_key_short_circuits_before_pmid` (mocked: `get_by_zotero_item_key` patched, `db.execute` must not be awaited when a key is given with a pmid).

- [ ] **Step 2: Run to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/integration/test_article_canonical_identity.py tests/unit/test_article_repository.py -q -p no:randomly`
Expected: failures — `TypeError: … unexpected keyword argument 'pmid'`, `ImportError: cannot import name 'PUBMED_FILL_FIELDS'`.

- [ ] **Step 3: Implement** the Interfaces block in `article_repository.py` and `article_source_normalization.py`.

- [ ] **Step 4: Run the tests, plus Zotero's to prove its path is unchanged**

Run: `cd "$WT/backend" && uv run pytest tests/integration/test_article_canonical_identity.py tests/unit/test_article_repository.py tests/unit/test_zotero_import_service.py -q -p no:randomly`
Expected: all pass.

- [ ] **Step 5: Lint, scope gate, commit**

Run: `make -C "$WT" lint-backend && cd "$WT/backend" && uv run python ../scripts/fitness/check_scope_guards.py` (fitness scripts need Python ≥ 3.11; the system `python3` is 3.9)
Expected: both exit 0.

```bash
git -C "$WT" add backend/app/repositories/article_repository.py backend/app/services/article_source_normalization.py backend/tests/unit/test_article_repository.py backend/tests/integration/test_article_canonical_identity.py
git -C "$WT" commit -m "feat(articles): match canonical identity by pmid, doi, url and add the fill-only upsert" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: PubMed import endpoint, Celery task, per-PMID events, poll route

**Seat:** backend · **Depends on:** Tasks 1, 2, 3

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Layering: the endpoint imports schemas, services and `app.api.deps.security` only, never models or repositories; the endpoint commits. Envelope: `ApiResponse[T]` with a typed `T`; errors are `HTTPException` or `AppError` subclasses; the new code goes into `ApiErrorCode` (`backend/app/schemas/common.py:51`) first. Every endpoint has `@limiter.limit(...)` and `request: Request`. Every `responses=` entry carries a `"description"` (`scripts/fitness/check_response_descriptions.py`). BOLA: one predicate, in the WHERE clause. Celery: arguments are primitives; the task builds its own session with `worker_session()` and runs through `run_task` (`backend/app/worker/tasks/import_tasks.py:52-109` is the shape); `time_limit` stays under the 3600 s visibility timeout (`backend/app/worker/celery_app.py:62`). Integration tests run on the dedicated DB through `$WT/backend/.env` (bootstrap: `$WT/docs/superpowers/plans/2026-10-23-screening-v1-ai-prescreen-a.md` § Global Constraints → Test database); never `make db-fresh`/`reset-db`. Vulture is shrink-only. The post-edit hook strips unused imports.

**Files:**
- Modify: `backend/app/schemas/common.py` (`ApiErrorCode.NCBI_EMAIL_NOT_CONFIGURED = "NCBI_EMAIL_NOT_CONFIGURED"`)
- Create: `backend/app/schemas/pubmed_import.py`
- Modify: `backend/app/repositories/article_repository.py` (`get_owned_run` :200-207; two methods on `ArticleSyncEventRepository` :227)
- Create: `backend/app/services/pubmed_import_service.py`
- Modify: `backend/app/worker/tasks/import_tasks.py` (new task; same module, so `celery_app` include/routes need no change — it routes to `imports`, `celery_app.py:76`)
- Create: `backend/app/api/v1/endpoints/pubmed_import.py`; Modify: `backend/app/api/v1/router.py` (import the module; `api_router.include_router(pubmed_import.router, tags=["imports"])`, no prefix — the routes carry full paths, like `template_catalogue` at :44)
- Create: `backend/tests/unit/test_pubmed_import_unit.py`, `backend/tests/integration/test_pubmed_import.py`

**Interfaces:**
- Consumes: `PubMedClient`, `PubMedFetchError`, `EFETCH_BATCH_SIZE` (`backend/app/services/pubmed_client.py`, Task 2); `normalize_pubmed_record`, `PUBMED_FILL_FIELDS` (`backend/app/services/article_source_normalization.py`, Tasks 2–3); `ArticleRepository.fill_only_upsert`, `.existing_pmids` (Task 3); `ArticleSyncRunRepository.create_run` (:182-198), `.update_counts` (:209-224); `ArticleSyncEventRepository.create_event` (:231-256, pass `zotero_item_key=None`); `take_advisory_xact_lock` (`backend/app/services/advisory_locks.py:16`); `queue_health.is_queue_available` (`backend/app/worker/queue_health.py:10`); `require_project_scope` (`backend/app/api/deps/security.py:161`).
- Produces (`schemas/pubmed_import.py`): `MAX_PMIDS = 10_000`; `PubmedImportRequest` (`extra="forbid"`; `pmids: list[Annotated[str, StringConstraints(pattern=r"^[0-9]{1,10}$")]] = Field(min_length=1, max_length=MAX_PMIDS)`; `dry_run: bool = False`); `PubmedDryRunRead` (`kind: Literal["dry_run"]`, `received`, `distinct`, `duplicate_in_request`, `already_in_project`, `new`: int); `PubmedImportStarted` (`kind: Literal["started"]`, `sync_run_id: UUID`, `status: Literal["pending"]`); `PubmedImportResult = Annotated[PubmedDryRunRead | PubmedImportStarted, Field(discriminator="kind")]`; `ImportRunRead` (`sync_run_id: UUID`, `source: str`, `status: str`, `total_received`, `persisted`, `updated`, `skipped`, `failed`: int, `started_at: datetime`, `completed_at: datetime | None`).
- Produces (repository): `ArticleSyncRunRepository.get_owned_run(self, sync_run_id: UUID, user_id: UUID, *, project_id: UUID | None = None)` — adds `.where(ArticleSyncRun.project_id == project_id)` when given (spec-gate #2); `ArticleSyncEventRepository.pmids_with_events(self, sync_run_id: UUID) -> set[str]` (`event_payload ->> 'pmid'`); `.status_counts(self, sync_run_id: UUID) -> dict[str, int]` (GROUP BY status).
- Produces (`services/pubmed_import_service.py`):
  - `PUBMED_IMPORT_LOCK = UUID("e2d0f3dc-4692-406e-bcaa-5df90c43fcf6")` (spec-gate #10).
  - `class NcbiEmailMissingError(AppError)` → code `NCBI_EMAIL_NOT_CONFIGURED`, status 503, message `"PubMed import is not configured on this server."`; `class ImportQueueUnavailableError(Exception)`; `class ImportRunNotFoundError(Exception)`.
  - `def run_counts(status_counts: Mapping[str, int], *, total_received: int) -> dict[str, int]` → `{"total_received": total_received, "persisted": inserted, "updated": updated, "skipped": duplicate_in_request, "failed": not_found + failed}` (spec-gate #13).
  - `class PubmedImportService(db)`: `dry_run(project_id, pmids) -> PubmedDryRunRead` (DB only, no NCBI, writes nothing); `start(project_id, requester_id) -> UUID` (`settings.NCBI_EMAIL` blank → `NcbiEmailMissingError`; `not queue_health.is_queue_available()` → `ImportQueueUnavailableError`; then `create_run(source="pubmed", source_collection_key=None)`; flush only); `mark_failed(sync_run_id) -> None` (status `failed`, flush); `get_run(*, project_id, requester_id, sync_run_id) -> ImportRunRead` (`get_owned_run(..., project_id=project_id)`; `None` → `ImportRunNotFoundError`); `run_import(*, project_id, sync_run_id, pmids: Sequence[str], client: PubMedClient, batch_size: int = EFETCH_BATCH_SIZE) -> None`.
- Produces (task): `import_pubmed_task(self, project_id: str, sync_run_id: str, pmids: list[str], trace_id: str | None = None) -> dict[str, str]` with `@celery_app.task(bind=True, max_retries=0, time_limit=1800)` — no `self.retry` (spec-gate #14). It builds `PubMedClient(email=settings.NCBI_EMAIL)` (a worker without `NCBI_EMAIL` raises `ValueError` there); any exception → rollback, `mark_failed`, commit, log `pubmed_import.aborted`, return `{"sync_run_id": …, "status": "failed"}`.
- Produces (routes): `POST /api/v1/projects/{project_id}/imports/pubmed` → 200 `PubmedDryRunRead` (dry run) or 202 `PubmedImportStarted`; `GET /api/v1/projects/{project_id}/imports/{sync_run_id}` → `ImportRunRead`.

**`run_import` algorithm (the part the signature does not determine):**
```text
run = ArticleSyncRunRepository.get_by_id(sync_run_id); stop if missing or run.project_id != project_id
set run.status = "running"; commit
done = events.pmids_with_events(sync_run_id)          # resume: a redelivered task skips these (spec-gate #14)
todo = [p for p in dict.fromkeys(pmids) if p not in done]; repeats = Counter(pmids)
for batch in chunks(todo, batch_size):                # serial; client spaces calls ≥ 0.34 s
    try records = await client.efetch(batch); except PubMedFetchError as exc: records = None
    await take_advisory_xact_lock(db, project_id, PUBMED_IMPORT_LOCK)   # after the network call
    for pmid in batch:
        records None          → status "failed", error_code "NCBI_UNAVAILABLE", article_id None
        pmid not in records   → status "not_found", article_id None
        normalize raises      → status "failed", error_code "PARSE_ERROR", article_id None
        else fill_only_upsert(payload, canonical_identity, PUBMED_FILL_FIELDS) → "inserted" | "updated", article_id
        create_event(..., status, event_payload={"pmid": pmid}); then repeats[pmid]-1 events
            with status "duplicate_in_request" and the same article_id
    update_counts(run, run_counts(status_counts(run), total_received=len(pmids)), "running"); commit   # releases the lock
update_counts(..., "completed"); commit
```

- [ ] **Step 1: Write the failing unit tests** (`backend/tests/unit/test_pubmed_import_unit.py`):

```python
def test_run_counts_mapping():
    assert run_counts({"inserted": 3, "updated": 1, "duplicate_in_request": 2, "not_found": 1, "failed": 1},
                      total_received=8) == {"total_received": 8, "persisted": 3, "updated": 1, "skipped": 2, "failed": 2}

@pytest.mark.parametrize("pmids", [[], ["12a"], ["1" * 11], [str(i) for i in range(1, 10_002)]],
                         ids=["empty", "non-digit", "too-long", "over-10000"])
def test_request_rejects(pmids):  # PubmedImportRequest(pmids=pmids) raises ValidationError

# Direct calls of the handler coroutines (diff coverage; pattern backend/tests/unit/test_entry_create_endpoint_unit.py:30-37,
# `_handler = pubmed_import.import_pubmed.__wrapped__`, service methods patched):
async def test_handler_dry_run_returns_counts(): ...           # 200 envelope, kind "dry_run", start never awaited
async def test_handler_queue_unavailable_is_503(): ...          # JSONResponse 503, error.code "SERVICE_UNAVAILABLE"
async def test_handler_failed_enqueue_marks_run_failed(): ...   # delay raises → mark_failed awaited, commit, 503
async def test_handler_started_is_202(): ...                    # delay called with project_id, sync_run_id, pmids, trace_id
async def test_poll_handler_missing_run_is_404(): ...           # ImportRunNotFoundError → HTTPException 404
```

- [ ] **Step 2: Write the failing integration tests** (`backend/tests/integration/test_pubmed_import.py`). A `fixture_client(...)` helper builds `PubMedClient(email="dev@prumo.test", transport=httpx.MockTransport(handler), sleep=<no-op>)` whose handler answers `backend/tests/fixtures/pubmed/efetch_batch.xml` (or a status/empty set as each test needs). HTTP tests use `client_as(profile, db_session)` (`backend/tests/integration/helpers/engine_setup.py:45-77`) with `SEED.primary_profile` (manager of both seeded projects), `SEED.reviewer_profile` (member of the primary project), `SEED.outsider_profile`; `monkeypatch` `settings.NCBI_EMAIL`, `app.worker.queue_health.is_queue_available` and `pubmed_import.import_pubmed_task.delay`.

```python
async def test_dry_run_counts_and_writes_nothing(db_session):
    # project article with pmid "42908551"; dry_run(["42908551","42875467","42875467","42706533"])
    # == received 4, distinct 3, duplicate_in_request 1, already_in_project 1, new 2; article_sync_runs count unchanged

async def test_run_import_writes_one_event_per_received_pmid(db_session):
    # pmids ["42908551","42875467","42706533","49999999","42908551","49999999"]
    # events by status: inserted 3, not_found 1, duplicate_in_request 2; the 42908551 duplicate has the
    # first occurrence's article_id; the 49999999 duplicate has article_id None; every event_payload == {"pmid": …}
    # run: total_received 6, persisted 3, updated 0, skipped 2, failed 1, status "completed", completed_at set

async def test_reimport_updates_and_inserts_nothing(db_session):   # second run: updated 3, article count unchanged
async def test_rerunning_the_same_run_duplicates_nothing(db_session):
    # run_import twice with the same sync_run_id and pmids → events == 6, run counts identical to the first pass

async def test_ncbi_failure_fails_its_batch_and_continues(db_session):
    # batch_size=2, pmids ["42908551","42875467","42706533"], handler answers 500 on its first call only →
    # 42908551, 42875467: status "failed", error_code "NCBI_UNAVAILABLE"; 42706533 inserted; run "completed"

async def test_batches_are_serial_and_at_most_200(db_session):
    # 450 distinct PMIDs, handler answers an empty set and records len(id param) and an in-flight flag →
    # sizes == [200, 200, 50], never two requests in flight; 450 not_found events

@pytest.mark.parametrize("source", ["zotero", "RIS"])
async def test_pubmed_match_keeps_the_existing_provenance(db_session, source):
    # article doi "https://doi.org/10.3389/FENDO.2026.1959304", abstract None, ingestion_source=source,
    # source_payload {"key": "K"} → import 42908551 → one "updated" event naming that article;
    # ingestion_source and source_payload unchanged; abstract filled; no new article

async def test_concurrent_overlapping_imports_create_no_duplicate_article(session_factory):
    # session_factory as backend/tests/integration/test_run_lifecycle_concurrency.py:33-39 (real commits);
    # a throwaway project (INSERT projects + manager membership; finally DELETE the project — cascades);
    # two runs, both importing ["42908551","42875467"], run concurrently with asyncio.gather →
    # one article per PMID; across both runs: inserted 2, updated 2

async def test_import_requires_membership(db_session):     # outsider: POST and GET → 403
async def test_import_validation_is_422(db_session):       # 10_001 PMIDs, "12a", [] → 422 VALIDATION_ERROR
async def test_dry_run_needs_no_ncbi_email(db_session):     # NCBI_EMAIL None, dry_run → 200; delay not called
async def test_import_refuses_without_ncbi_email(db_session):  # dry_run False → 503 NCBI_EMAIL_NOT_CONFIGURED; no run row
async def test_import_refuses_when_queue_is_down(db_session):  # probe False → 503 SERVICE_UNAVAILABLE; no run row
async def test_import_enqueues_after_commit(db_session):
    # 202, data.kind "started"; delay called once with pmids; run row: source "pubmed", status "pending",
    # requested_by_user_id = caller
async def test_failed_enqueue_marks_the_run_failed(db_session):   # delay raises → 503; run status "failed"
async def test_poll_is_bound_to_project_and_requester(db_session):
    # manager starts in SEED.primary_project → GET /projects/{primary}/imports/{sid} as manager 200 with counts;
    # as SEED.reviewer_profile (member, not requester) 404; as manager on /projects/{secondary}/imports/{sid} 404;
    # outsider 403
```

- [ ] **Step 3: Run to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_pubmed_import_unit.py tests/integration/test_pubmed_import.py -q -p no:randomly`
Expected: collection errors (`No module named 'app.schemas.pubmed_import'`).

- [ ] **Step 4: Implement** the error code, schemas, repository methods, service, task, endpoint and router wiring per the Interfaces block. In the POST handler: dry run → `ApiResponse.success(...)` (200, needs neither email nor queue); else `start` (`ImportQueueUnavailableError` → 503 envelope with `SERVICE_UNAVAILABLE`, as `backend/app/api/v1/endpoints/extraction_batches.py:40-48`; `NcbiEmailMissingError` propagates to the app's `AppError` handler, which answers 503 with its code), `await db.commit()`, then `import_pubmed_task.delay(project_id=…, sync_run_id=…, pmids=body.pmids, trace_id=…)`; a failed `.delay` → `mark_failed`, commit, 503 `SERVICE_UNAVAILABLE`; success → `JSONResponse(status_code=202, content=ApiResponse.success(...).model_dump(mode="json"))`. Declare `responses={202: {"description": "Import queued; poll the sync run"}, 503: {"description": "Task queue unavailable or NCBI_EMAIL unset"}}`. Rate limits: POST `10/minute`, GET `120/minute`. Both routes take `user_sub: UUID = Depends(require_project_scope)`.

- [ ] **Step 5: Run the tests**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_pubmed_import_unit.py tests/integration/test_pubmed_import.py tests/unit/test_celery_app_task_registry.py -q -p no:randomly`
Expected: all pass.

- [ ] **Step 6: Gates and commit**

Run: `make -C "$WT" lint-backend && cd "$WT/backend" && uv run python ../scripts/vulture_baseline.py --baseline .vulture_baseline --exec && for s in check_layered_arch check_api_response_envelope check_scope_guards check_response_descriptions; do uv run python ../scripts/fitness/$s.py || exit 1; done` (fitness scripts need Python ≥ 3.11; never the system `python3`, which is 3.9)
Expected: every command exits 0.

```bash
git -C "$WT" add backend/app/schemas/common.py backend/app/schemas/pubmed_import.py backend/app/repositories/article_repository.py backend/app/services/pubmed_import_service.py backend/app/worker/tasks/import_tasks.py backend/app/api/v1/endpoints/pubmed_import.py backend/app/api/v1/router.py backend/tests/unit/test_pubmed_import_unit.py backend/tests/integration/test_pubmed_import.py
git -C "$WT" commit -m "feat(screening): import PubMed records by PMID through the canonical path" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Screening config (`reviewer_count`) and enrollment

**Seat:** backend · **Depends on:** Task 1

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Layering: endpoints import schemas, services and `app.api.deps.*` only; repositories flush, the endpoint commits. `projects.settings` is written only through `ProjectRepository.update_settings_key` (`backend/app/repositories/project_repository.py:44-60`). Role flags come from the `public.is_project_*` SQL functions (a service runs `SELECT public.is_project_manager(:pid, :uid)` directly; never `project_members` SQL). Enroll binds client article ids through `article_read_service.owned_articles` (`backend/app/services/article_read_service.py:38-62`) — the one article-in-project guard. Envelope `ApiResponse[T]`; new codes in `ApiErrorCode` first; `@limiter.limit` on every endpoint; request schemas `extra="forbid"`. Integration tests on the dedicated DB through `$WT/backend/.env` (bootstrap: `$WT/docs/superpowers/plans/2026-10-23-screening-v1-ai-prescreen-a.md` § Global Constraints → Test database); never `make db-fresh`/`reset-db`. Vulture shrink-only. The post-edit hook strips unused imports.

**Config shape decision (slice A):** `projects.settings.screening` stores `{"reviewer_count": n}`; the writer MERGES into the old value (`{**(old or {}), "reviewer_count": n}`), so slice B adds `ai_visible` as a sibling key with no migration and no slice-A change. Slice A exposes no `ai_visible` field: nothing reads or writes it until slice B, and an inert API field would be dead contract (YAGNI).

**Files:**
- Modify: `backend/app/schemas/common.py` (`SCREENING_CONFIG_FROZEN`, `SCREENING_TOO_FEW_REVIEWERS`)
- Create: `backend/app/schemas/screening.py`
- Create: `backend/app/services/screening_errors.py`
- Create: `backend/app/repositories/screening_repository.py`
- Create: `backend/app/services/screening_config_service.py`
- Create: `backend/app/api/v1/endpoints/screening.py`; Modify: `backend/app/api/v1/router.py` (`api_router.include_router(screening.router, tags=["screening"])`, no prefix — full paths)
- Create: `backend/tests/integration/helpers/screening_fixtures.py`, `backend/tests/integration/test_screening_config.py`, `backend/tests/unit/test_screening_config_unit.py`

**Interfaces:**
- Consumes: `ScreeningAssignment`, `ScreeningDecision`, `SCREENING_PHASE` (`backend/app/models/screening.py`, Task 1); `ProjectRepository.lock_for_update` (:29-42), `.update_settings_key` (:44-60); `ProjectMemberRepository.count_reviewer_capable` (:73-83); `owned_articles`, `ArticleNotFoundError`; `require_project_scope` (`backend/app/api/deps/security.py:161`), `require_project_manager` (:177).
- Produces (`schemas/screening.py`): `ScreeningConfigRead` (`reviewer_count: int | None`, `reviewer_count_locked: bool`, `reviewer_capable: int`, `enrolled: int`, `not_enrolled: int`, `can_manage: bool`, `can_review: bool`, `can_arbitrate: bool`); `ScreeningConfigUpdate` (`reviewer_count: int = Field(ge=1, le=3)`, `extra="forbid"`); `ScreeningEnrollRequest` (`article_ids: list[UUID] | None = Field(default=None, min_length=1, max_length=10_000)`, `extra="forbid"`); `ScreeningEnrollResult` (`enrolled: int`, `already_enrolled: int`).
- Produces (`services/screening_errors.py`): `class ScreeningStateError(AppError)` — `__init__(self, code: ApiErrorCode, message: str)`, status 409, `code=code.value`. Tasks 6–7 raise it with their own codes.
- Produces (`repositories/screening_repository.py`, class `ScreeningRepository(db)`): `enroll(project_id: UUID, enrolled_by: UUID, article_ids: Sequence[UUID] | None) -> int` (one `INSERT … SELECT` from `articles` filtered by `project_id` [and `id = ANY(ids)`], `ON CONFLICT (project_id, article_id, phase) DO NOTHING`, returns rowcount; ids and `enrolled_at` come from server defaults, so one call's rows share `enrolled_at`); `count_enrolled(project_id) -> int`; `count_project_articles(project_id) -> int`; `project_has_decision(project_id) -> bool` (EXISTS decision joined to an assignment of the project).
- Produces (`services/screening_config_service.py`): `SCREENING_SETTINGS_KEY = "screening"`; `def reviewer_count_of(settings: Mapping[str, Any] | None) -> int | None` (the int at `settings["screening"]["reviewer_count"]` when it is 1..3, else `None`); `@dataclass(frozen=True) class ScreeningRoles(can_manage: bool, can_review: bool, can_arbitrate: bool)`; `async def screening_roles(db, project_id: UUID, user_id: UUID) -> ScreeningRoles` (one SELECT of `public.is_project_manager`, `public.is_project_reviewer`, `public.is_project_arbitrator`) — Tasks 6–7 import this, never a copy; `class ProjectNotFoundError(Exception)`; `class ScreeningConfigService(db)`: `read(project_id, viewer_id) -> ScreeningConfigRead`, `set_reviewer_count(project_id, viewer_id, reviewer_count: int) -> ScreeningConfigRead`, `enroll(project_id, enrolled_by, article_ids: list[UUID] | None) -> ScreeningEnrollResult`.
- `set_reviewer_count` order: `lock_for_update` (None → `ProjectNotFoundError`); current = `reviewer_count_of(project.settings)`; if `current is not None and current != n and project_has_decision` → `ScreeningStateError(SCREENING_CONFIG_FROZEN, "Reviewers per record cannot change after the first decision.")`; if `n > count_reviewer_capable` → `ScreeningStateError(SCREENING_TOO_FEW_REVIEWERS, "The project has fewer reviewers than that.")`; then `update_settings_key(project_id, "screening", merge)` (re-locking is a no-op) and return `read(...)`. Decisions in Task 6 read this value under `FOR SHARE`, so the row lock here serializes with them.
- `enroll`: ids given → `owned_articles` first (foreign or missing → `ArticleNotFoundError`, nothing written); `already_enrolled = len(candidates) - enrolled` where candidates = the deduplicated ids, or every project article (`removed_at_source` included — ruling #26).
- Produces (routes, `endpoints/screening.py`): `GET /api/v1/projects/{project_id}/screening/config` (`require_project_scope`, `60/minute`); `PUT` same path (`require_project_manager`, `30/minute`, `ProjectNotFoundError` → 404); `POST /api/v1/projects/{project_id}/screening/enroll` (`require_project_manager`, `10/minute`, `ArticleNotFoundError` → 404, body optional: `{}` = enroll all).
- Produces (test helpers, `tests/integration/helpers/screening_fixtures.py`; later tasks extend it): `make_project(db, *, manager: UUID = SEED.primary_profile) -> UUID` (INSERT `projects` (`id`, `name`, `created_by_id`) + manager membership); `add_member(db, project_id: UUID, role: str) -> UUID` (new `auth.users` + `profiles` + `project_members` row — pattern `backend/tests/integration/test_blind_review_isolation.py:120-143`, fresh uuid4 per call); `make_screening_article(db, project_id: UUID, **fields) -> UUID` (ORM `Article`, title default `"Screening article"`); `enroll_articles(db, project_id: UUID, article_ids: Sequence[UUID], *, by: UUID) -> list[UUID]` (ORM assignments, same order); `add_decision(db, assignment_id: UUID, reviewer_id: UUID, decision: str, *, reason: str | None = None) -> UUID`; `set_reviewer_count(db, project_id: UUID, n: int) -> None` (writes `settings["screening"]` through `ProjectRepository.update_settings_key`).

- [ ] **Step 1: Write the failing tests.** Unit (`test_screening_config_unit.py`):

```python
@pytest.mark.parametrize(("settings", "expected"), [
    (None, None), ({}, None), ({"screening": {}}, None), ({"screening": {"reviewer_count": 2}}, 2),
    ({"screening": {"reviewer_count": 4}}, None), ({"screening": {"reviewer_count": "2"}}, None),
    ({"screening": {"reviewer_count": 1, "ai_visible": True}}, 1),
], ids=["none", "empty", "no-count", "two", "out-of-range", "string", "sibling-key"])
def test_reviewer_count_of(settings, expected): ...

def test_config_update_bounds():  # ScreeningConfigUpdate(reviewer_count=0) and (4) raise ValidationError; extra key raises
# plus direct handler calls (pattern backend/tests/unit/test_entry_create_endpoint_unit.py:30-37) for the PUT 404 and
# enroll 404 translations
```

Integration (`test_screening_config.py`; each test builds its own project with `make_project` so counts are exact; HTTP through `client_as` from `backend/tests/integration/helpers/engine_setup.py:45-77`):

```python
async def test_config_read_unconfigured(db_session):
    # project: manager M, reviewer R, viewer V, 2 articles → as M: reviewer_count None, reviewer_count_locked False,
    # reviewer_capable 2, enrolled 0, not_enrolled 2, (can_manage, can_review, can_arbitrate) == (True, True, True);
    # as R: (False, True, False); as V: (False, False, False); outsider → 403

async def test_put_config_persists_and_keeps_sibling_settings(db_session):
    # settings preset {"managers_see_reviewers": {"extraction": True}}; PUT {"reviewer_count": 2} → 200, reviewer_count 2;
    # settings == {"managers_see_reviewers": {"extraction": True}, "screening": {"reviewer_count": 2}}

@pytest.mark.parametrize("role", ["reviewer", "viewer", "consensus"])
async def test_put_config_requires_manager(db_session, role):  # → 403
@pytest.mark.parametrize("value", [0, 4])
async def test_put_config_out_of_range_is_422(db_session, value): ...
async def test_put_config_above_reviewer_capable(db_session):  # 2 capable, PUT 3 → 409 SCREENING_TOO_FEW_REVIEWERS
async def test_reviewer_count_frozen_after_first_decision(db_session):
    # PUT 2; enroll; add_decision; PUT 1 → 409 SCREENING_CONFIG_FROZEN; PUT 2 → 200; GET → reviewer_count_locked True

async def test_enroll_all_is_idempotent(db_session):
    # 3 articles; POST {} → {"enrolled": 3, "already_enrolled": 0}; again → {"enrolled": 0, "already_enrolled": 3};
    # the 3 rows share one enrolled_at; enrolled_by == manager
async def test_enroll_selected(db_session):  # POST {"article_ids": [a1]} → {1, 0}; again → {0, 1}
async def test_enroll_refuses_a_foreign_article(db_session):  # id from another project → 404; zero rows inserted
async def test_enroll_requires_manager(db_session):  # reviewer → 403
async def test_enroll_all_includes_removed_at_source(db_session):  # sync_state "removed_at_source" article is enrolled
```

- [ ] **Step 2: Run to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_screening_config_unit.py tests/integration/test_screening_config.py -q -p no:randomly`
Expected: collection errors (`No module named 'app.services.screening_config_service'`).

- [ ] **Step 3: Implement** the codes, schemas, error class, repository, service, endpoints, router line and test helpers per the Interfaces block.

- [ ] **Step 4: Run the tests**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_screening_config_unit.py tests/integration/test_screening_config.py -q -p no:randomly`
Expected: all pass.

- [ ] **Step 5: Gates and commit**

Run: `make -C "$WT" lint-backend && cd "$WT/backend" && uv run python ../scripts/vulture_baseline.py --baseline .vulture_baseline --exec && for s in check_layered_arch check_api_response_envelope check_scope_guards check_response_descriptions; do uv run python ../scripts/fitness/$s.py || exit 1; done` (never the system `python3`, which is 3.9)
Expected: every command exits 0.

```bash
git -C "$WT" add backend/app/schemas/common.py backend/app/schemas/screening.py backend/app/services/screening_errors.py backend/app/repositories/screening_repository.py backend/app/services/screening_config_service.py backend/app/api/v1/endpoints/screening.py backend/app/api/v1/router.py backend/tests/integration/helpers/screening_fixtures.py backend/tests/integration/test_screening_config.py backend/tests/unit/test_screening_config_unit.py
git -C "$WT" commit -m "feat(screening): configure reviewers per record and enroll articles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Outcome derivation, queue, decisions, blind read, `load_assignment_for_member`

**Seat:** backend · **Depends on:** Tasks 1, 5

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Layering: endpoints import schemas, services and `app.api.deps.*` only; the by-id guard lives in `app/api/deps/scope.py` and calls a service, never a repository. BOLA: an assignment id is resolved by ONE guard (`load_assignment_for_member`), then the route checks the role on that assignment's own project; scope in the WHERE clause; no `db.get`-then-compare copies. Blind review is a hard boundary: other reviewers' decisions leave the API only when the assignment has an outcome, or to an arbitrator while it is in conflict. Decisions are INSERT-only (never UPDATE a decision row). Envelope `ApiResponse[T]`; new codes in `ApiErrorCode` first, raised as `ScreeningStateError` (`backend/app/services/screening_errors.py`, Task 5); `@limiter.limit` on every endpoint. Integration tests on the dedicated DB through `$WT/backend/.env` (bootstrap: `$WT/docs/superpowers/plans/2026-10-23-screening-v1-ai-prescreen-a.md` § Global Constraints → Test database); never `make db-fresh`/`reset-db`. Vulture shrink-only. The post-edit hook strips unused imports.

**Files:**
- Modify: `backend/app/schemas/common.py` (`SCREENING_NOT_CONFIGURED`, `SCREENING_REVIEWER_CAP`, `SCREENING_UNKNOWN_EXCLUSION_REASON`)
- Modify: `backend/app/schemas/screening.py`
- Create: `backend/app/services/screening_outcome.py` (pure)
- Create: `backend/app/services/screening_review_service.py`
- Modify: `backend/app/repositories/screening_repository.py`, `backend/app/repositories/project_repository.py` (one method)
- Modify: `backend/app/services/project_ai_context.py` (two functions after `_protocol_lines`, :175-194)
- Modify: `backend/app/api/deps/scope.py` (after `load_run_for_member`, :39-54), `backend/app/api/v1/endpoints/screening.py`
- Modify: `.claude/rules/backend.md` § Ownership guards (after the "A run by id" bullet, :72-76)
- Create: `backend/tests/unit/test_screening_outcome.py`, `backend/tests/unit/test_protocol_exclusion_reasons.py`, `backend/tests/unit/test_screening_review_unit.py`, `backend/tests/integration/test_screening_review.py`, `backend/tests/integration/test_screening_concurrency.py`
- Modify: `backend/tests/integration/helpers/screening_fixtures.py` (add `add_ruling(db, assignment_id: UUID, decided_by: UUID, decision: str, *, reason: str | None = None, selected: UUID | None = None) -> UUID`, a direct ORM insert for setup)

**Interfaces:**
- Consumes: Task 1 models; Task 5 `reviewer_count_of`, `screening_roles`, `ScreeningRoles`, `ScreeningStateError`, `ScreeningRepository`, test helpers in `backend/tests/integration/helpers/screening_fixtures.py`; `_SLOT_KEYS` (`project_ai_context.py:53-60`), `_texts` (:98-114), `_string_list` (:117-121), `_timing_texts` (:124-144), `_load` (:305-309); `ensure_project_member` (`security.py:107`), `ensure_project_reviewer` (:120), `get_current_user_sub` (:11).
- Produces (`services/screening_outcome.py`, frozen slotted dataclasses): `CurrentDecision(id: UUID, reviewer_id: UUID, decision: str, exclusion_reason: str | None, created_at: datetime)`; `CurrentRuling(id: UUID, decision: str, exclusion_reason: str | None, created_at: datetime)`; `Outcome(kind: Literal["solo", "consensus", "arbitrated"], decision: str, exclusion_reason: str | None, reasons_differ: bool)`; `AssignmentState(phase: Literal["pending", "conflict", "decided"], outcome: Outcome | None)`;
  - `def derive_state(reviewer_count: int, decisions: Sequence[CurrentDecision], ruling: CurrentRuling | None) -> AssignmentState` — `decisions` holds each reviewer's CURRENT decision. Ruling → decided `arbitrated` (the latest ruling stands even when reviewers later change). Else fewer than `reviewer_count` decisions → pending. Else `reviewer_count == 1` → `solo`. Else all equal → `consensus` (exclusion reason = the single distinct reason, `None` included; several distinct values → reason `None`, `reasons_differ=True`). Else → conflict.
  - `def caller_status(state: AssignmentState, decisions: Sequence[CurrentDecision], caller_id: UUID, *, is_arbitrator: bool, can_review: bool) -> Literal["awaiting_me", "awaiting_others", "conflict", "decided"]` — outcome → `decided`; conflict → `conflict` for an arbitrator, `awaiting_others` for anyone else (a reviewer must not learn that a peer disagreed); pending → `awaiting_me` only when `can_review` and the caller has no decision, else `awaiting_others` (a viewer is never asked to act).
  - `def reveals_peers(state: AssignmentState, *, is_arbitrator: bool) -> bool` — `state.outcome is not None or (state.phase == "conflict" and is_arbitrator)`. The ONE reveal rule; Task 7 imports it.
- Produces (`schemas/screening.py`): `ScreeningDecisionValue = Literal["include", "exclude", "maybe"]`; `ScreeningArticle` (`id`, `title`, `abstract`, `authors: list[str] | None`, `journal_title`, `publication_year`, `pmid`, `doi`); `ScreeningQueueItem` (`assignment_id`, `article`); `ScreeningQueueRead` (`items: list[ScreeningQueueItem]`, `awaiting_me: int`, `awaiting_others: int`, `exclusion_reasons: list[str]`); `ScreeningDecisionCreate` (`extra="forbid"`, `decision`, `exclusion_reason: str | None = Field(None, max_length=1000)`, `rationale: str | None = Field(None, max_length=2000)`; `model_validator(mode="after")`: a reason only with `decision == "exclude"` → 422); `ScreeningDecisionRead` (`id`, `decision`, `exclusion_reason`, `rationale`, `created_at`); `PeerDecisionRead(ScreeningDecisionRead)` + `reviewer_id: UUID`, `reviewer_name: str | None`; `ScreeningOutcomeRead` (`kind`, `decision`, `exclusion_reason`, `reasons_differ`); `ScreeningAssignmentRead` (`id`, `project_id`, `article`, `status`, `my_decision: ScreeningDecisionRead | None`, `outcome: ScreeningOutcomeRead | None`, `peer_decisions: list[PeerDecisionRead]`, `exclusion_reasons: list[str]`); `ScreeningAssignmentRef` (`id`, `project_id`, `article_id`; `from_attributes=True`).
- Produces (`project_ai_context.py`): `def protocol_exclusion_reasons(picots: Any, eligibility: Any) -> list[str]` (every PICOTS slot's `exclusion[]` in `_SLOT_KEYS` order, timing through `_timing_texts`, then `eligibility.exclusion[]`; stripped, deduplicated, first occurrence kept); `async def load_exclusion_reasons(db, project_id: UUID) -> list[str]`. Independent of the `ai_context.picots` switch: these are the protocol's reasons for humans (the switch governs AI prompts, slice B).
- Produces (repositories): `ProjectRepository.settings_for_share(project_id) -> dict[str, Any] | None` (`select(Project.settings) … .with_for_update(read=True)` → `FOR SHARE`); on `ScreeningRepository`: `get_assignment(assignment_id) -> ScreeningAssignment | None`; `lock_assignment(assignment_id) -> None` (`.with_for_update(key_share=True)` → `FOR NO KEY UPDATE`, which does not block the KEY SHARE an FK insert takes); `current_decisions(*, project_id: UUID | None = None, assignment_ids: Sequence[UUID] | None = None) -> list[ScreeningDecision]` (`DISTINCT ON (assignment_id, reviewer_id) … ORDER BY assignment_id, reviewer_id, created_at DESC, id DESC`); `latest_rulings(*, project_id=None, assignment_ids=None) -> dict[UUID, ScreeningArbitration]` (`DISTINCT ON (assignment_id)`, latest by `created_at, id`); `queue_page(project_id, reviewer_id, reviewer_count, *, limit: int = 20) -> list[tuple[UUID, Article]]` and `count_awaiting_me(project_id, reviewer_id, reviewer_count) -> int`, both built from ONE private query: project's `title_abstract` assignments with no ruling, no decision by `reviewer_id`, and fewer than `reviewer_count` distinct reviewers, ordered `enrolled_at, md5(id::text)`; `article_of(assignment_id) -> Article`; `add_decision(assignment_id, reviewer_id, decision, exclusion_reason, rationale) -> ScreeningDecision`; `display_names(user_ids) -> dict[UUID, str | None]` (`profiles.full_name`).
- Produces (`services/screening_review_service.py`): `class AssignmentNotFoundError(Exception)`; `async def get_assignment_ref(db, assignment_id: UUID) -> ScreeningAssignmentRef`; `class ScreeningReviewService(db)`: `queue(project_id, reviewer_id) -> ScreeningQueueRead` (`awaiting_others` = the caller's decided assignments whose derived state has no outcome); `get_assignment(assignment_id, viewer_id) -> ScreeningAssignmentRead` (peers only when `reveals_peers`; `my_decision` = the viewer's current decision); `decide(assignment_id, reviewer_id, body: ScreeningDecisionCreate) -> ScreeningAssignmentRead`.
- `decide` order (spec §7): `settings_for_share(project)` → `reviewer_count_of` is `None` → `SCREENING_NOT_CONFIGURED`; `lock_assignment`; a reason not in `load_exclusion_reasons` → `SCREENING_UNKNOWN_EXCLUSION_REASON` ("The protocol's exclusion reasons changed. Reload and pick again."); caller has no current decision and the assignment already has `reviewer_count` distinct reviewers → `SCREENING_REVIEWER_CAP` ("This record already has all its reviewers."); `add_decision`; return `get_assignment(...)` in the same transaction. Lock order is always project row then assignment row (Task 7 keeps it).
- Produces (`api/deps/scope.py`): `async def load_assignment_for_member(db: AsyncSession, assignment_id: UUID, user_sub: UUID) -> ScreeningAssignmentRef` — `AssignmentNotFoundError` → 404, then `ensure_project_member` on `ref.project_id` (403).
- Produces (routes): `GET /api/v1/projects/{project_id}/screening/queue` (`ensure_project_reviewer` on the path project, `120/minute`); `GET /api/v1/screening/assignments/{assignment_id}` (`load_assignment_for_member`, `120/minute`); `POST /api/v1/screening/assignments/{assignment_id}/decisions` (`load_assignment_for_member`, then `ensure_project_reviewer(db, ref.project_id, user_sub)`, body `ScreeningDecisionCreate`, returns `ScreeningAssignmentRead`, `120/minute`).
- Rules doc: add to `.claude/rules/backend.md` after the "A run by id" bullet: "**An assignment by id** → `api/deps/scope.load_assignment_for_member`. Same shape as `load_run_for_member`: it resolves the screening assignment, then checks membership on the assignment's own project (404 missing / 403 non-member) and returns `ScreeningAssignmentRef`, not the ORM row. Decision and arbitration routes then run `ensure_project_reviewer` / `ensure_project_arbitrator` on `ref.project_id`."

- [ ] **Step 1: Write the failing unit tests.** `test_screening_outcome.py` — one parametrized table (`ids=` per row), reviewers `A`, `B`, `C`:

| id | rc | current decisions | ruling | phase | outcome (kind, decision, reason, differ) |
|---|---|---|---|---|---|
| solo-pending | 1 | — | — | pending | — |
| solo | 1 | A exclude "R1" | — | decided | solo, exclude, "R1", False |
| dual-pending | 2 | A include | — | pending | — |
| dual-consensus | 2 | A include, B include | — | decided | consensus, include, None, False |
| dual-conflict | 2 | A include, B exclude | — | conflict | — |
| dual-same-reason | 2 | A exclude "R1", B exclude "R1" | — | decided | consensus, exclude, "R1", False |
| dual-reasons-differ | 2 | A exclude "R1", B exclude "R2" | — | decided | consensus, exclude, None, True |
| reason-vs-none | 2 | A exclude "R1", B exclude None | — | decided | consensus, exclude, None, True |
| triple-pending | 3 | A include, B include | — | pending | — |
| triple-consensus | 3 | A, B, C include | — | decided | consensus, include, None, False |
| triple-conflict | 3 | A include, B include, C maybe | — | conflict | — |
| ruling-stands | 2 | A include, B include | exclude "R2" | decided | arbitrated, exclude, "R2", False |

plus `test_caller_status` (pending & caller decided → `awaiting_others`; pending & not decided → `awaiting_me`; pending & viewer (`can_review=False`) → `awaiting_others`; conflict → `conflict` for an arbitrator, `awaiting_others` for a reviewer; outcome → `decided`) and `test_reveals_peers` (conflict: arbitrator True, reviewer False; pending: False for both; decided: True for both).

`test_protocol_exclusion_reasons.py`: picots `{"population": {"exclusion": ["Children", " "]}, "timing": {"prediction_moment": {"exclusion": ["After discharge"]}}}` with eligibility `{"exclusion": ["Not ML", "Children"]}` → `["Children", "After discharge", "Not ML"]`; `None`/junk inputs → `[]`.

`test_screening_review_unit.py`: `ScreeningDecisionCreate(decision="include", exclusion_reason="R1")` raises; direct handler calls (pattern `backend/tests/unit/test_entry_create_endpoint_unit.py:30-37`) for the queue, assignment and decision handlers' success paths.

- [ ] **Step 2: Write the failing integration tests.** `test_screening_review.py`: each test builds a project with `make_project`, members with `add_member`, articles with `make_screening_article`, assignments with `enroll_articles`, sets `projects.eligibility_criteria = {"exclusion": ["Wrong population", "Not ML"]}`, and `set_reviewer_count`; HTTP via `client_as` (`backend/tests/integration/helpers/engine_setup.py:45-77`).

```python
async def test_solo_outcome(db_session):  # rc 1: R POST exclude "Not ML" → 200, status "decided", outcome solo exclude "Not ML"
async def test_dual_blind_until_consensus(db_session):
    # rc 2, reviewers A, B: A POST include → A's view status "awaiting_others", peer_decisions [], outcome None;
    # B GET → status "awaiting_me", my_decision None, peer_decisions []; B POST include → outcome consensus include;
    # A GET → peer_decisions == [B's decision] with reviewer_name
async def test_conflict_is_hidden_from_reviewers_and_shown_to_arbitrators(db_session):
    # A include, B exclude → A and B: status "awaiting_others", peer_decisions [], outcome None;
    # manager M (arbitrator, not a reviewer here) GET → status "conflict", 2 peer_decisions
async def test_three_reviewers(db_session):  # rc 3: two include → pending; third include → consensus
async def test_reviewer_beyond_cap_is_409(db_session):
    # rc 2, A and B decided; C POST → 409 SCREENING_REVIEWER_CAP; A POST maybe → 200 and A has 2 rows, current = maybe
async def test_reviewer_change_after_a_ruling_leaves_it_in_force(db_session):
    # rc 2, A include, B exclude, a ruling row (exclude) inserted directly; A POST exclude → outcome still arbitrated exclude
async def test_viewer_reads_but_cannot_decide(db_session):  # viewer GET → 200, status "awaiting_others"; POST → 403
async def test_outsider_and_foreign_assignment(db_session):
    # outsider GET/POST → 403; random uuid → 404; a member of project P only, asking for an assignment of project Q → 403
async def test_unknown_exclusion_reason_is_refused(db_session):  # reason "Old reason" → 409 SCREENING_UNKNOWN_EXCLUSION_REASON
async def test_reason_on_include_is_422(db_session): ...
async def test_unconfigured_project(db_session):  # no reviewer_count: POST and GET queue → 409 SCREENING_NOT_CONFIGURED
async def test_deleted_article_assignment_is_404(db_session):  # delete the article → GET assignment → 404
async def test_queue_contents_and_order(db_session):
    # rc 2; enrollment 1: 12 articles, enrollment 2 (later): 13 articles → reviewer A's queue has 20 items;
    # every enrollment-1 assignment precedes every enrollment-2 one; within an enrollment the order equals
    # sorted(ids, key=lambda i: hashlib.md5(str(i).encode()).hexdigest()); a second call returns the same order;
    # after A decides the 1st item, B and C decide the 2nd (cap), and a ruling exists on the 3rd:
    # none of the three is in A's queue; awaiting_me == 22, awaiting_others == 1; exclusion_reasons == ["Wrong population", "Not ML"]
async def test_queue_requires_reviewer_role(db_session):  # viewer → 403
```

`test_screening_concurrency.py` (`session_factory` as `backend/tests/integration/test_run_lifecycle_concurrency.py:33-39`; real commits in a throwaway project deleted in `finally`; the cascade removes its screening rows):

```python
async def test_two_reviewers_deciding_at_once_reach_consensus(session_factory):
    # rc 2, A and B each run `await ScreeningReviewService(s).decide(...); await s.commit()` in their own session,
    # both coroutines under asyncio.gather → both succeed; derived outcome consensus include
async def test_cap_holds_when_three_reviewers_decide_at_once(session_factory):
    # rc 2, A, B, C at once → exactly two succeed, one raises ScreeningStateError with code SCREENING_REVIEWER_CAP;
    # the assignment has exactly 2 decision rows
```

- [ ] **Step 3: Run to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_screening_outcome.py tests/unit/test_protocol_exclusion_reasons.py tests/unit/test_screening_review_unit.py tests/integration/test_screening_review.py tests/integration/test_screening_concurrency.py -q -p no:randomly`
Expected: collection errors (`No module named 'app.services.screening_outcome'`).

- [ ] **Step 4: Implement** per the Interfaces block (codes, schemas, pure module, repository and service methods, guard, routes, rules-doc bullet).

- [ ] **Step 5: Run the tests**

Run: same command as Step 3.
Expected: all pass. Then mutation-check the order: delete `.order_by(...)` from the queue query, rerun `-k queue_contents_and_order`, see it fail, restore.

- [ ] **Step 6: Gates and commit**

Run: `make -C "$WT" lint-backend && cd "$WT/backend" && uv run python ../scripts/vulture_baseline.py --baseline .vulture_baseline --exec && for s in check_layered_arch check_api_response_envelope check_scope_guards check_response_descriptions; do uv run python ../scripts/fitness/$s.py || exit 1; done` (never the system `python3`, which is 3.9)
Expected: every command exits 0.

```bash
git -C "$WT" add backend/app/schemas/common.py backend/app/schemas/screening.py backend/app/services/screening_outcome.py backend/app/services/screening_review_service.py backend/app/repositories/screening_repository.py backend/app/repositories/project_repository.py backend/app/services/project_ai_context.py backend/app/api/deps/scope.py backend/app/api/v1/endpoints/screening.py .claude/rules/backend.md backend/tests/unit/test_screening_outcome.py backend/tests/unit/test_protocol_exclusion_reasons.py backend/tests/unit/test_screening_review_unit.py backend/tests/integration/test_screening_review.py backend/tests/integration/test_screening_concurrency.py backend/tests/integration/helpers/screening_fixtures.py
git -C "$WT" commit -m "feat(screening): blind title/abstract queue, decisions and derived outcomes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Conflicts list, arbitration, `owned_decisions`

**Seat:** backend · **Depends on:** Task 6

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. BOLA: ruled-on and selected decision ids are bound to their assignment by ONE new guard, `owned_decisions` (scope in the WHERE clause; missing and foreign raise the same 404-class error naming no field of the foreign row); the assignment id goes through `load_assignment_for_member` (`backend/app/api/deps/scope.py`, Task 6); the role is `ensure_project_arbitrator` (`backend/app/api/deps/security.py:148`) on the assignment's own project. Arbitrations are INSERT-only. Lock order: project row `FOR SHARE`, then assignment `FOR NO KEY UPDATE` (as `decide` in Task 6). Blind reveal goes through `reveals_peers` (`backend/app/services/screening_outcome.py`, Task 6) — never a second rule. Envelope `ApiResponse[T]`; new codes in `ApiErrorCode` first, raised as `ScreeningStateError`; `@limiter.limit` on every endpoint. Integration tests on the dedicated DB through `$WT/backend/.env` (bootstrap: `$WT/docs/superpowers/plans/2026-10-23-screening-v1-ai-prescreen-a.md` § Global Constraints → Test database); never `make db-fresh`/`reset-db`. Vulture shrink-only. The post-edit hook strips unused imports.

**Files:**
- Modify: `backend/app/schemas/common.py` (`SCREENING_NOT_IN_CONFLICT`, `SCREENING_STALE_DECISIONS`)
- Modify: `backend/app/schemas/screening.py`, `backend/app/services/screening_review_service.py`, `backend/app/repositories/screening_repository.py`, `backend/app/api/v1/endpoints/screening.py`
- Modify: `scripts/fitness/check_scope_guards.py:53-63` (`"assignment_id"` into `SCOPE_COLUMNS`)
- Modify: `.claude/rules/backend.md` § Ownership guards, row-in-parent list (:77-94): add "`screening_review_service.owned_decisions` (screening decisions in their assignment)"
- Modify: `backend/tests/unit/scripts/test_check_scope_guards_canary.py`
- Create: `backend/tests/integration/test_screening_arbitration.py`, `backend/tests/unit/test_screening_arbitration_unit.py`

**Interfaces:**
- Consumes (Task 6): `derive_state`, `reveals_peers`, `CurrentDecision`, `CurrentRuling`; `ScreeningRepository.current_decisions`, `.latest_rulings`, `.lock_assignment`, `.display_names`; `ProjectRepository.settings_for_share`; `load_exclusion_reasons`; `ScreeningReviewService.get_assignment`; (Task 5) `reviewer_count_of`, `screening_roles`, `ScreeningStateError`.
- Produces (`schemas/screening.py`): `ScreeningConflictItem` (`assignment_id: UUID`, `article: ScreeningArticle`, `decisions: list[PeerDecisionRead]`); `ScreeningConflictsRead` (`items: list[ScreeningConflictItem]`, `exclusion_reasons: list[str]` — the protocol strings an override may cite); `ScreeningArbitrationCreate` (`extra="forbid"`; `ruled_on_decision_ids: list[UUID] = Field(min_length=1, max_length=3)`; `selected_decision_id: UUID | None = None`; `decision: ScreeningDecisionValue | None = None`; `exclusion_reason: str | None = Field(None, max_length=1000)`; `rationale: str | None = Field(None, max_length=2000)`; validator: exactly one of `selected_decision_id` / `decision`; `selected_decision_id` must be in `ruled_on_decision_ids`; `exclusion_reason` only with `decision == "exclude"` — each violation → 422).
- Produces (repository): `ScreeningRepository.decisions_in_assignment(assignment_id: UUID, decision_ids: Sequence[UUID]) -> list[ScreeningDecision]` (`WHERE assignment_id = :aid AND id = ANY(:ids)`); `add_arbitration(assignment_id, decision, exclusion_reason, selected_decision_id, rationale, decided_by) -> ScreeningArbitration`; `assignments_with_articles(assignment_ids: Sequence[UUID]) -> list[tuple[UUID, Article]]` (queue order `enrolled_at, md5(id::text)`).
- Produces (`services/screening_review_service.py`):
  - `class DecisionNotFoundError(Exception)`.
  - `async def owned_decisions(db, *, assignment_id: UUID, decision_ids: Sequence[UUID]) -> list[ScreeningDecision]` — THE decision-in-assignment guard: deduplicated ids, input order, only when EVERY id belongs to `assignment_id`; else `DecisionNotFoundError("Decision not found")`.
  - `ScreeningReviewService.conflicts(project_id, viewer_id) -> ScreeningConflictsRead` — `items`: assignments whose derived phase is `conflict` (unruled), in queue order, with every current decision and reviewer name (unconfigured project → no items); `exclusion_reasons`: `load_exclusion_reasons(db, project_id)`.
  - `ScreeningReviewService.arbitrate(assignment_id, arbitrator_id, body: ScreeningArbitrationCreate) -> ScreeningAssignmentRead`, in order: `settings_for_share` (unconfigured → `SCREENING_NOT_CONFIGURED`); `lock_assignment`; `owned_decisions(ruled_on_decision_ids)` (→ `DecisionNotFoundError`; a forged `selected_decision_id` from another assignment fails here because it must be among the ruled-on ids); derive the state from current decisions and latest ruling — accepted only when phase is `conflict` or the outcome kind is `arbitrated`, else `SCREENING_NOT_IN_CONFLICT` ("This record is not in conflict."); `set(ruled_on_decision_ids) != {current decision ids}` → `SCREENING_STALE_DECISIONS` ("The decisions changed since you opened this conflict. Reload it."); decision and reason = the selected decision's, or the override's (override reason not in `load_exclusion_reasons` → `SCREENING_UNKNOWN_EXCLUSION_REASON`); `add_arbitration(..., decided_by=arbitrator_id)`; return `get_assignment(assignment_id, arbitrator_id)`. No self-exclusion: an arbitrator who reviewed the record may rule it (ruling #24).
- Produces (routes): `GET /api/v1/projects/{project_id}/screening/conflicts` (`ensure_project_arbitrator` on the path project, `60/minute`, returns `ScreeningConflictsRead`); `POST /api/v1/screening/assignments/{assignment_id}/arbitration` (`load_assignment_for_member`, then `ensure_project_arbitrator(db, ref.project_id, user_sub)`, `DecisionNotFoundError` → 404, `60/minute`, returns `ScreeningAssignmentRead`).

- [ ] **Step 1: Write the failing canary** in `test_check_scope_guards_canary.py` (same `_plant`/`_run` helpers as the file's existing tests):

```python
_DECISION_GUARD = """from sqlalchemy import select
from app.models.screening import ScreeningDecision


async def {name}(db, decision_id, assignment_id):
    return (await db.execute(select(ScreeningDecision).where(
        ScreeningDecision.id == decision_id, ScreeningDecision.assignment_id == assignment_id,
    ))).scalar_one_or_none()
"""

def test_fires_on_a_second_decision_in_assignment_predicate(tmp_path):
    # plant owned_a and owned_b → returncode 1 and "ScreeningDecision{assignment_id,id}" in stdout
```

Run: `cd "$WT/backend" && uv run pytest tests/unit/scripts/test_check_scope_guards_canary.py -q -k decision_in_assignment`
Expected: FAIL (returncode 0 — `assignment_id` is not yet a scope column).

- [ ] **Step 2: Add `"assignment_id"` to `SCOPE_COLUMNS`**, rerun Step 1's command → PASS; then `cd "$WT/backend" && uv run python ../scripts/fitness/check_scope_guards.py` → exit 0 on the real tree (if it now reports a duplicate, consolidate into the one guard instead of baselining).

- [ ] **Step 3: Write the failing tests.** Unit (`test_screening_arbitration_unit.py`): the three validator rules each raise; direct handler calls (pattern `backend/tests/unit/test_entry_create_endpoint_unit.py:30-37`) for the conflicts handler and the arbitration handler's 404 translation. Integration (`test_screening_arbitration.py`, builders from `backend/tests/integration/helpers/screening_fixtures.py`, rc 2, reviewers A and B, manager M, consensus member K, protocol exclusions `["Wrong population", "Not ML"]`):

```python
async def test_conflicts_list_for_arbitrators(db_session):
    # a1: A include / B exclude "Not ML" (conflict); a2: both include (consensus); a3: only A (pending)
    # M GET conflicts → items exactly [a1] with 2 decisions and reviewer names, exclusion_reasons == ["Wrong population", "Not ML"];
    # K → same; A → 403; viewer → 403
async def test_rule_by_selecting_a_decision(db_session):
    # M POST {"ruled_on_decision_ids": [dA, dB], "selected_decision_id": dB} → 200, outcome arbitrated exclude "Not ML";
    # the ruling row has selected_decision_id == dB; conflicts list is empty; A now sees both peers
async def test_rule_by_override(db_session):  # {"ruled_on_decision_ids": [dA, dB], "decision": "maybe"} → selected NULL, outcome maybe
async def test_stale_decision_ids_are_409(db_session):
    # M reads conflicts (ids dA, dB); A changes include → maybe (new row dA2; B stays exclude, still a conflict);
    # POST with [dA, dB] → 409 SCREENING_STALE_DECISIONS; POST with [dA2, dB] → 200
async def test_not_in_conflict_is_409(db_session):  # pending a3 and consensus a2 → 409 SCREENING_NOT_IN_CONFLICT
async def test_forged_selected_decision_is_refused(db_session):
    # selected_decision_id (and ruled-on id) taken from another assignment → 404; no ruling row written
async def test_re_ruling_an_arbitrated_record(db_session):  # second POST with current ids → 200; the latest ruling wins
async def test_reviewer_cannot_arbitrate(db_session):  # A (reviewer role) POST → 403
async def test_arbitrator_may_rule_a_conflict_they_reviewed(db_session):  # M reviewed a1 and rules it → 200
async def test_override_reason_must_be_in_the_protocol(db_session):  # decision exclude, reason "Old" → 409 SCREENING_UNKNOWN_EXCLUSION_REASON
```

- [ ] **Step 4: Run to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_screening_arbitration_unit.py tests/integration/test_screening_arbitration.py -q -p no:randomly`
Expected: failures (`ImportError: cannot import name 'ScreeningArbitrationCreate'`).

- [ ] **Step 5: Implement** per the Interfaces block, plus the `.claude/rules/backend.md` line.

- [ ] **Step 6: Run the tests** (Step 4's command, plus `tests/unit/scripts/` and Task 6's review suite to catch regressions)

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_screening_arbitration_unit.py tests/integration/test_screening_arbitration.py tests/integration/test_screening_review.py tests/unit/scripts -q -p no:randomly`
Expected: all pass.

- [ ] **Step 7: Gates and commit**

Run: `make -C "$WT" lint-backend && cd "$WT/backend" && uv run python ../scripts/vulture_baseline.py --baseline .vulture_baseline --exec && for s in check_layered_arch check_api_response_envelope check_scope_guards check_response_descriptions; do uv run python ../scripts/fitness/$s.py || exit 1; done` (never the system `python3`, which is 3.9)
Expected: every command exits 0.

```bash
git -C "$WT" add backend/app/schemas/common.py backend/app/schemas/screening.py backend/app/services/screening_review_service.py backend/app/repositories/screening_repository.py backend/app/api/v1/endpoints/screening.py scripts/fitness/check_scope_guards.py .claude/rules/backend.md backend/tests/unit/scripts/test_check_scope_guards_canary.py backend/tests/integration/test_screening_arbitration.py backend/tests/unit/test_screening_arbitration_unit.py
git -C "$WT" commit -m "feat(screening): list conflicts and record arbitration rulings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: PRISMA identification and screening counts

**Seat:** backend · **Depends on:** Tasks 4, 6 (and 7 for rulings in data)

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Nothing derivable is stored: every count is computed on read from articles, sync events, assignments, decisions and rulings. Outcomes come from `derive_state` (`backend/app/services/screening_outcome.py`, Task 6) — never a second derivation. Single-use queries are inline `select()` in the owning service; reused shapes stay in `ScreeningRepository`. Every query filters by the path project. Envelope `ApiResponse[T]`; `@limiter.limit`; `require_project_scope` (`backend/app/api/deps/security.py:161`). Integration tests on the dedicated DB through `$WT/backend/.env` (bootstrap: `$WT/docs/superpowers/plans/2026-10-23-screening-v1-ai-prescreen-a.md` § Global Constraints → Test database); never `make db-fresh`/`reset-db`. Vulture shrink-only. The post-edit hook strips unused imports.

**Files:**
- Create: `backend/app/schemas/prisma.py`, `backend/app/services/prisma_service.py`, `backend/app/api/v1/endpoints/prisma.py`
- Modify: `backend/app/api/v1/router.py` (`api_router.include_router(prisma.router, tags=["prisma"])`, no prefix — full path)
- Create: `backend/tests/unit/test_prisma_screening_box.py`, `backend/tests/integration/test_prisma_counts.py`

**Interfaces:**
- Consumes: `ScreeningRepository.current_decisions`, `.latest_rulings` (Task 6); `derive_state`, `AssignmentState`, `CurrentDecision`, `CurrentRuling` (Task 6); `reviewer_count_of` (Task 5); `PubmedImportService.run_import` and the fixture client pattern of `backend/tests/integration/test_pubmed_import.py` (Task 4) for test data; `ScreeningConfigService.enroll` (Task 5).
- Produces (`schemas/prisma.py`): `PrismaSourceCount` (`source: str`, `count: int`); `PrismaReasonCount` (`reason: str`, `count: int`); `PrismaCountsRead` (`identified: list[PrismaSourceCount]`, `identified_total: int`, `duplicates_removed: int`, `not_retrieved: int`, `imported_not_enrolled: int`, `screened: int`, `pending: int`, `in_conflict: int`, `excluded: int`, `excluded_by_reason: list[PrismaReasonCount]`, `excluded_reasons_differ: int`, `excluded_without_reason: int`, `sought_for_retrieval: int`).
- Produces (`services/prisma_service.py`):
  - `@dataclass(frozen=True) class ScreeningBox(screened, pending, in_conflict, excluded: int, excluded_by_reason: dict[str, int], excluded_reasons_differ, excluded_without_reason, sought_for_retrieval: int)`; `def screening_box(states: Sequence[AssignmentState]) -> ScreeningBox` (pure: `screened = len(states)`; pending / conflict by phase; an outcome `exclude` counts under its reason, under `excluded_reasons_differ` when `reasons_differ`, or under `excluded_without_reason`; `include` and `maybe` → `sought_for_retrieval`).
  - `async def prisma_counts(db, project_id: UUID) -> PrismaCountsRead`, with these definitions (spec §8, spec-gate #12):
    - enrolled = the project's `title_abstract` assignments.
    - Identified, PubMed = `count(DISTINCT event_payload->>'pmid')` over `article_sync_events` joined to `article_sync_runs` (`runs.project_id = :pid`, `runs.source = 'pubmed'`), `status IN ('inserted','updated','duplicate_in_request')`, `article_id IS NOT NULL`, and the article enrolled in this project. Listed first as `{"source": "pubmed", …}` (omitted when 0).
    - Identified, other sources = enrolled articles with `lower(coalesce(ingestion_source, 'manual')) <> 'pubmed'`, grouped by that expression, sorted by source.
    - `identified_total` = sum; `duplicates_removed` = `identified_total - enrolled` (never clamped; the docstring states the invariant that every enrolled article is counted at least once).
    - `not_retrieved` = distinct PMIDs of the project's `pubmed` runs with `bool_and(status NOT IN ('inserted','updated'))`.
    - `imported_not_enrolled` = project articles with no assignment.
    - screening box = `screening_box([derive_state(rc, …) for each enrolled assignment])`; with `rc is None` every assignment is pending.
- Produces (route): `GET /api/v1/projects/{project_id}/prisma` (`require_project_scope`, `60/minute`) → `PrismaCountsRead`.

- [ ] **Step 1: Write the failing unit test** (`test_prisma_screening_box.py`): states = pending ×1, conflict ×1, solo exclude "Not ML" ×2, consensus exclude reasons-differ ×1, consensus exclude without reason ×1, consensus include ×2, arbitrated maybe ×1 → `ScreeningBox(screened=9, pending=1, in_conflict=1, excluded=4, excluded_by_reason={"Not ML": 2}, excluded_reasons_differ=1, excluded_without_reason=1, sought_for_retrieval=3)`.

- [ ] **Step 2: Write the failing integration tests** (`test_prisma_counts.py`; a fresh project per test via `make_project` from `backend/tests/integration/helpers/screening_fixtures.py`; imports run through `PubmedImportService(db).run_import(...)` with the MockTransport client over `backend/tests/fixtures/pubmed/efetch_batch.xml`; enrollment through `ScreeningConfigService(db).enroll(...)`):

```python
async def test_pubmed_only_import_identified_equals_screened(db_session):
    # import ["42908551","42875467","42706533"], enroll all → identified [{"pubmed", 3}], identified_total 3,
    # duplicates_removed 0, screened 3, not_retrieved 0, imported_not_enrolled 0     (§8 check, scaled from 1,976)
async def test_pubmed_matching_a_ris_article_counts_one_duplicate(db_session):
    # RIS article doi "https://doi.org/10.3389/FENDO.2026.1959304"; import ["42908551"]; enroll all →
    # identified [{"pubmed",1},{"ris",1}], total 2, duplicates_removed 1, screened 1        (§8 check)
async def test_reimporting_the_same_file_changes_nothing(db_session):  # two imports → counts identical  (§8 check)
async def test_not_found_pmids_are_not_duplicates(db_session):
    # import ["42908551","49999999","49999999"] → not_retrieved 1, duplicates_removed 0, identified_total 1
async def test_imported_but_not_enrolled_is_not_identified(db_session):
    # import 3, enroll 1 → identified_total 1, imported_not_enrolled 2
async def test_deleted_article_is_not_counted_as_not_retrieved(db_session):
    # import 3, delete one article → not_retrieved 0 (status-based, spec-gate #12)
async def test_screening_box_from_rows(db_session):
    # rc 2, four enrolled manual articles: consensus include, consensus exclude "Not ML", conflict, pending →
    # identified [{"manual", 4}], screened 4, sought 1, excluded 1 with {"Not ML": 1}, in_conflict 1, pending 1
async def test_prisma_route_guard(db_session):  # member → 200 with the counts; outsider → 403
```

- [ ] **Step 3: Run to see them fail**

Run: `cd "$WT/backend" && uv run pytest tests/unit/test_prisma_screening_box.py tests/integration/test_prisma_counts.py -q -p no:randomly`
Expected: collection errors (`No module named 'app.services.prisma_service'`).

- [ ] **Step 4: Implement** schemas, service, route, router line.

- [ ] **Step 5: Run the tests**

Run: same command as Step 3.
Expected: all pass.

- [ ] **Step 6: Run the whole backend slice and the gates, then commit**

Run: `cd "$WT/backend" && uv run pytest tests/unit tests/integration/test_screening_schema.py tests/integration/test_article_canonical_identity.py tests/integration/test_pubmed_import.py tests/integration/test_screening_config.py tests/integration/test_screening_review.py tests/integration/test_screening_concurrency.py tests/integration/test_screening_arbitration.py tests/integration/test_prisma_counts.py -q -p no:randomly`
Expected: all pass.

Run: `make -C "$WT" lint-backend && cd "$WT/backend" && uv run alembic check && uv run python ../scripts/vulture_baseline.py --baseline .vulture_baseline --exec && for s in check_layered_arch check_api_response_envelope check_scope_guards check_response_descriptions; do uv run python ../scripts/fitness/$s.py || exit 1; done` (never the system `python3`, which is 3.9)
Expected: every command exits 0; `alembic check` prints `No new upgrade operations detected.`

```bash
git -C "$WT" add backend/app/schemas/prisma.py backend/app/services/prisma_service.py backend/app/api/v1/endpoints/prisma.py backend/app/api/v1/router.py backend/tests/unit/test_prisma_screening_box.py backend/tests/integration/test_prisma_counts.py
git -C "$WT" commit -m "feat(screening): derive PRISMA identification and screening counts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: API types, Screening tab shell, configuration and enrollment UI

**Seat:** frontend · **Depends on:** Tasks 1–8 (all backend schemas exist, so the types are generated once here)

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Frontend tooling runs from `$WT` (repo root) — never `cd frontend && npm …`; the worktree needs its own `node_modules` (`npm ci` in `$WT` once; never a symlink). Data path: component → hook (TanStack Query) → `frontend/services/*Service.ts` → `apiClient`; services return `ErrorResult<T>` via `toResult` (`frontend/lib/error-utils.ts`) and never throw or toast; keys come from a factory in `frontend/lib/query-keys/`; a mutation invalidates the owning key family. Types come from `frontend/types/api/schema.d.ts`, generated, never hand-edited. Every user-facing string goes through `t('screening', key)`; every key you add is referenced (copy-key gate) and every new file is reachable from production code (knip both modes at zero). React Compiler: no `try/finally` or `throw` inside `try` in component/hook bodies; read form state where it is consumed (`useWatch`, `useFormState`). Forms are react-hook-form + Zod. Icon-only controls are `IconButton` (`frontend/components/patterns/IconButton.tsx`). The post-edit hook strips unused imports: add an import in the edit that first uses it. Fitness scripts run as `cd "$WT/backend" && uv run python ../scripts/fitness/<name>.py` (the system `python3` is 3.9).

**Files:**
- Regenerate: `frontend/types/api/openapi.json`, `frontend/types/api/schema.d.ts`
- Create: `frontend/lib/copy/screening.ts`; Modify: `frontend/lib/copy/index.ts` (import :5-28 and the `copy` object :41-66)
- Create: `frontend/lib/query-keys/screening.ts`, `frontend/services/screeningService.ts`, `frontend/hooks/screening/useScreeningConfig.ts`, `frontend/lib/screening/errors.ts`
- Create: `frontend/components/screening/ScreeningTab.tsx`, `frontend/components/screening/ScreeningConfigForm.tsx`, `frontend/components/screening/ScreeningHeader.tsx`
- Modify: `frontend/pages/ProjectView.tsx:250-251` (render `<ScreeningTab projectId={projectId || ''} />`; drop the now-unused `ListChecks` import), `frontend/components/layout/sidebarConfig.ts:54` (remove `comingSoon: true` from `screening`)
- Create: `frontend/components/screening/__tests__/ScreeningTab.test.tsx`, `frontend/test/pages/ProjectView.screeningTabs.test.tsx`, `frontend/test/sidebar-screening-tabs.test.ts`

**Interfaces:**
- Consumes (generated types, `components['schemas'][…]`): `ScreeningConfigRead`, `ScreeningConfigUpdate`, `ScreeningEnrollRequest`, `ScreeningEnrollResult`. Routes: `GET`/`PUT /api/v1/projects/{id}/screening/config`, `POST /api/v1/projects/{id}/screening/enroll` (Tasks 5).
- Produces (`frontend/lib/query-keys/screening.ts`): `export const screeningKeys = { all: ['screening'] as const, project: (projectId: string) => [...screeningKeys.all, 'project', projectId] as const, config: (projectId: string) => [...screeningKeys.project(projectId), 'config'] as const } as const` (the shape of `frontend/lib/query-keys/extractionBatch.ts`) — later tasks add `queue`, `assignment`, `conflicts`, `prisma`, `importRun` under the same `project(projectId)` prefix (except `assignment(assignmentId)`, under `all`). Every screening mutation invalidates `screeningKeys.project(projectId)`.
- Produces (`frontend/services/screeningService.ts`): `fetchScreeningConfig(projectId): Promise<ErrorResult<ScreeningConfigRead>>`, `setScreeningConfig(projectId, body: ScreeningConfigUpdate)`, `enrollArticles(projectId, body: ScreeningEnrollRequest)` — each `toResult(() => apiClient<T>(…), 'screeningService.<name>')` like `frontend/services/aiContextService.ts:26-55`. Later tasks append their calls here.
- Produces (`frontend/hooks/screening/useScreeningConfig.ts`): `useScreeningConfig(projectId)` (`useQuery`, `queryFn` rethrows `result.error`, pattern `frontend/hooks/project/useAiContext.ts:28-38`); `useSetScreeningConfig(projectId)`, `useEnrollArticles(projectId)` (`useMutation`; on success invalidate `screeningKeys.project(projectId)`).
- Produces (`frontend/lib/screening/errors.ts`): `screeningErrorMessage(error: unknown): string` — an `ApiError` (`frontend/integrations/api/client.ts:68-80`) whose `code` is in a `Record<string, ScreeningCopyKey>` map returns `t('screening', key)`; otherwise status 403 → `errorForbidden`, 404 → `errorNotFound`, anything else → `errorGeneric`. This task maps `SCREENING_CONFIG_FROZEN` → `errorConfigFrozen`, `SCREENING_TOO_FEW_REVIEWERS` → `errorTooFewReviewers`; Tasks 10–12 add their codes to the same map. (`ScreeningCopyKey = keyof typeof screening`.)
- Produces (components): `ScreeningTab({projectId}: {projectId: string})` — state machine below; `ScreeningConfigForm({projectId, config})` (radio group 1–3, options above `reviewer_capable` disabled with `reviewerCountNeedsMembers`; RHF + Zod `z.object({reviewer_count: z.coerce.number().int().min(1).max(3)})`; submit → `useSetScreeningConfig`; 409 → inline `screeningErrorMessage`); `ScreeningHeader({projectId, config})` (summary chips and, for managers, an "Enroll {{n}} new" button when `not_enrolled > 0`). Tasks 10–12 add actions and bodies to these.

**Screening tab states (spec-gate #31, this task's share), checked in this order:**

| State | Condition | Renders (copy keys) |
|---|---|---|
| loading | query pending | skeleton with `aria-busy="true"` and sr-only `loading` |
| load error | query error | `ErrorState` title `loadErrorTitle`, message `screeningErrorMessage(error)`, retry → `refetch` |
| manager, not configured | `reviewer_count === null && can_manage` | `ScreeningConfigForm` (`configureTitle`, `configureDescription`, `reviewerCountOne`, `reviewerCountMany`, `reviewerCountNeedsMembers`, `configureSave`; toast `configSavedToast`) |
| non-manager, not configured | `reviewer_count === null && !can_manage` | notice `notConfiguredTitle` + `notConfiguredMember` |
| manager, nothing enrolled | `enrolled === 0 && can_manage` | empty state `nothingEnrolledTitle` + `nothingEnrolledManager`, button `enrollAll` (disabled with `nothingToEnroll` when `not_enrolled === 0`); toast `enrolledToast` |
| non-manager, nothing enrolled | `enrolled === 0 && !can_manage` | notice `nothingEnrolledTitle` + `nothingEnrolledMember` |
| running | otherwise | `ScreeningHeader` (`summaryEnrolled`, `summaryNotEnrolled`, `summaryReviewerOne`/`summaryReviewers`, `enrollNew`); body: viewer (`!can_review && !can_arbitrate`) → notice `viewerNotice`; reviewers and arbitrators get their bodies in Tasks 11–12 |

Copy (`frontend/lib/copy/screening.ts`, `export const screening = {…} as const`): `loading: 'Loading screening…'`, `loadErrorTitle: 'Could not load screening'`, `configureTitle: 'Reviewers per record'`, `configureDescription: 'Reviewers screen blind. When they disagree, an arbitrator decides.'`, `reviewerCountOne: '1 reviewer'`, `reviewerCountMany: '{{n}} reviewers'`, `reviewerCountNeedsMembers: 'Needs {{n}} reviewers in the project'`, `configureSave: 'Save'`, `configSavedToast: 'Screening is set up'`, `notConfiguredTitle: 'Screening is not set up yet'`, `notConfiguredMember: 'A project manager chooses how many reviewers screen each record.'`, `nothingEnrolledTitle: 'No records to screen'`, `nothingEnrolledManager: "Enroll the project's articles to start title and abstract screening."`, `nothingEnrolledMember: 'A project manager enrolls articles for screening.'`, `enrollAll: 'Enroll all articles'`, `nothingToEnroll: 'Add or import articles first'`, `enrolledToast: '{{n}} articles enrolled'`, `enrollNew: 'Enroll {{n}} new'`, `summaryEnrolled: '{{n}} enrolled'`, `summaryNotEnrolled: '{{n}} not enrolled'`, `summaryReviewerOne: '1 reviewer per record'`, `summaryReviewers: '{{n}} reviewers per record'`, `viewerNotice: 'You can follow screening here. Only reviewers screen records.'`, `errorConfigFrozen: 'Reviewers per record cannot change after the first decision.'`, `errorTooFewReviewers: 'The project has fewer reviewers than that.'`, `errorForbidden: 'You do not have permission to do this.'`, `errorNotFound: 'This record no longer exists.'`, `errorGeneric: 'Something went wrong. Please try again.'`. Fill `{{n}}` with `.replace('{{n}}', String(n))` (as `frontend/components/articles/ArticlesList.tsx:1216`).

- [ ] **Step 1: Regenerate the API types** (needs `$WT/backend/.env` from Task 1 and backend deps):

```bash
cd "$WT" && npm ci            # only if $WT/node_modules is missing
cd "$WT/backend" && uv sync --frozen --extra dev
cd "$WT" && npm run generate:api-types
grep -c "ScreeningConfigRead\|ScreeningAssignmentRead\|PrismaCountsRead\|PubmedImportRequest\|ImportRunRead" "$WT/frontend/types/api/schema.d.ts"   # expect ≥ 5
```

- [ ] **Step 2: Write the failing tests.** `ScreeningTab.test.tsx` (MSW `server.use(http.get('*/api/v1/projects/:projectId/screening/config', …))` with envelope bodies, a fresh `QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}})` per test, `vi.mock('@/integrations/supabase/client', …)` and `vi.mock('sonner', …)` as in `frontend/components/extraction/batch/__tests__/RunAIBatchDialog.test.tsx:9-25`):

```ts
it('shows a busy region while the config loads')            // role region with aria-busy=true
it('shows the load error and retries')                        // 500 → 'Could not load screening'; Retry refetches
it('lets a manager choose reviewers per record')               // reviewer_capable 2 → '3 reviewers' disabled; pick '2 reviewers', Save → PUT body {reviewer_count: 2}; toast 'Screening is set up'
it('explains a frozen reviewer count')                         // PUT → 409 SCREENING_CONFIG_FROZEN → 'Reviewers per record cannot change after the first decision.'
it('explains too few reviewers')                               // PUT → 409 SCREENING_TOO_FEW_REVIEWERS → 'The project has fewer reviewers than that.'
it('tells a non-manager that screening is not set up')         // can_manage false, reviewer_count null
it('lets a manager enroll all articles')                       // enrolled 0, not_enrolled 3 → 'Enroll all articles' → POST body {} → toast '3 articles enrolled'; config refetched
it('disables enroll when there is nothing to enroll')          // not_enrolled 0 → button disabled, 'Add or import articles first'
it('tells a non-manager that nothing is enrolled')
it('shows the viewer notice once screening runs')              // reviewer_count 2, enrolled 3, all flags false
it('summarises enrolment in the header')                       // '3 enrolled', '2 not enrolled', '2 reviewers per record', 'Enroll 2 new' (manager only)
```

`ProjectView.screeningTabs.test.tsx` (pattern `frontend/test/pages/ProjectView.articleEditor.test.tsx`, `ScreeningTab` mocked to a test id): `renderAt('/projects/p1?tab=screening')` → finds `screening-tab`; `queryByText('Coming soon')` is null. `sidebar-screening-tabs.test.ts`: the `screening` item's `comingSoon` is not `true`.

- [ ] **Step 3: Run to see them fail**

Run: `cd "$WT" && npx vitest run frontend/components/screening frontend/test/pages/ProjectView.screeningTabs.test.tsx frontend/test/sidebar-screening-tabs.test.ts`
Expected: FAIL (module `@/components/screening/ScreeningTab` not found).

- [ ] **Step 4: Implement** copy (and its `index.ts` registration), keys, service, hooks, errors map, components, `ProjectView` and `sidebarConfig` changes per the Interfaces block. Layout and density follow the `frontend-ux` skill (empty states, header); load it before styling.

- [ ] **Step 5: Run the tests and the gates**

Run: `cd "$WT" && npx vitest run frontend/components/screening frontend/test/pages frontend/test/sidebar-screening-tabs.test.ts frontend/test/sidebar-qa-tab.test.ts && npm run typecheck && npm run lint && npx knip --no-tag-hints && npx knip --production --no-tag-hints`
Expected: tests pass; typecheck, lint and both knip runs exit 0.

Run: `cd "$WT/backend" && for s in check_copy_keys check_react_query_keys check_frontend_data_path; do uv run python ../scripts/fitness/$s.py || exit 1; done`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add frontend/types/api/openapi.json frontend/types/api/schema.d.ts frontend/lib/copy/screening.ts frontend/lib/copy/index.ts frontend/lib/query-keys/screening.ts frontend/services/screeningService.ts frontend/hooks/screening/useScreeningConfig.ts frontend/lib/screening/errors.ts frontend/components/screening frontend/pages/ProjectView.tsx frontend/components/layout/sidebarConfig.ts frontend/test/pages/ProjectView.screeningTabs.test.tsx frontend/test/sidebar-screening-tabs.test.ts
git -C "$WT" commit -m "feat(screening): screening tab with reviewer setup and enrollment" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: PubMed import dialog (papaparse), PubMed source filter

**Seat:** frontend · **Depends on:** Task 9

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Frontend tooling from `$WT` only — never `cd frontend && npm …`. Data path: component → hook → `frontend/services/screeningService.ts` (returns `ErrorResult<T>`, never throws or toasts) → `apiClient`; keys from `frontend/lib/query-keys/screening.ts` (Task 9); the import's completion invalidates `screeningKeys.project(projectId)`. Types from `frontend/types/api/schema.d.ts` (generated in Task 9; regenerate with `npm run generate:api-types` only if a backend schema changed). Strings via `t('screening' | 'articles', key)`; every new key referenced, every new file reachable (knip both modes at zero). React Compiler: no `try/finally` or `throw` inside `try` in component/hook bodies — file IO lives in `frontend/lib/screening/pmidInput.ts`. Icon-only controls are `IconButton`. New dependencies are pinned exactly. The post-edit hook strips unused imports. Fitness scripts run as `cd "$WT/backend" && uv run python ../scripts/fitness/<name>.py` (the system `python3` is 3.9).

**Files:**
- Modify: `package.json`, `package-lock.json` (`papaparse` 5.7.0 exact in `dependencies`; `@types/papaparse` 5.5.2 exact in `devDependencies` — 5.7.0 ships no types)
- Create: `frontend/lib/screening/pmidInput.ts`, `frontend/hooks/screening/usePubmedImport.ts`, `frontend/components/screening/PubMedImportDialog.tsx`
- Modify: `frontend/services/screeningService.ts`, `frontend/lib/query-keys/screening.ts`, `frontend/lib/screening/errors.ts`, `frontend/lib/copy/screening.ts`, `frontend/lib/copy/articles.ts` (one key), `frontend/components/screening/ScreeningTab.tsx`, `frontend/components/screening/ScreeningHeader.tsx`, `frontend/pages/ProjectView.tsx` (pass `onImportComplete={loadArticles}` to `ScreeningTab`)
- Modify: `frontend/lib/articlesListDisplay.ts` (add `matchesSourceFilter`), `frontend/components/articles/ArticlesList.tsx:103-108` (option) and `:594-598` (use the helper)
- Create: `frontend/lib/screening/pmidInput.test.ts`, `frontend/components/screening/__tests__/PubMedImportDialog.test.tsx`, `frontend/test/lib/articlesSourceFilter.test.ts`; Modify: `frontend/components/screening/__tests__/ScreeningTab.test.tsx`

**Interfaces:**
- Consumes: routes `POST /api/v1/projects/{id}/imports/pubmed` (200 `PubmedDryRunRead` `kind: "dry_run"` · 202 `PubmedImportStarted` `kind: "started"` · 503 `NCBI_EMAIL_NOT_CONFIGURED` / `SERVICE_UNAVAILABLE` · 422 `VALIDATION_ERROR`) and `GET /api/v1/projects/{id}/imports/{sync_run_id}` (`ImportRunRead`; 404 when missing, foreign or another requester's) from Task 4; Task 9's `screeningKeys`, `screeningErrorMessage`, `ScreeningTab`, `ScreeningHeader`.
- Produces (`frontend/lib/screening/pmidInput.ts`): `MAX_PMIDS = 10_000`; `MAX_CSV_BYTES = 25 * 1024 * 1024`; `type PmidInputError = 'empty' | 'no_pmid_column' | 'invalid' | 'too_many' | 'file_too_large'`; `type PmidParseResult = {ok: true; pmids: string[]} | {ok: false; error: PmidInputError; invalid?: string[]}`; `parsePmidText(text: string): PmidParseResult` (split on `/[\s,;]+/`, drop blanks, keep repeats — the API counts them; any token not matching `/^[0-9]{1,10}$/` → `invalid` with the first 5 offenders; more than `MAX_PMIDS` tokens → `too_many`; none → `empty`); `parsePmidCsv(file: File): Promise<PmidParseResult>` (`file.size > MAX_CSV_BYTES` → `file_too_large` without reading; `Papa.parse<Record<string, string>>(await file.text(), {header: true, skipEmptyLines: true, transformHeader: (h) => h.replace(/^﻿/, '').trim()})`; the column whose header lower-cases to `pmid`, else `no_pmid_column`; its trimmed non-blank values then validated as in `parsePmidText`).
- Produces (service): `dryRunPubmedImport(projectId, pmids: string[]): Promise<ErrorResult<PubmedDryRunRead>>`, `startPubmedImport(projectId, pmids): Promise<ErrorResult<PubmedImportStarted>>`, `fetchImportRun(projectId, syncRunId): Promise<ErrorResult<ImportRunRead>>`.
- Produces (keys): `screeningKeys.importRun(projectId, syncRunId) = [...screeningKeys.project(projectId), 'import-run', syncRunId]`.
- Produces (`frontend/hooks/screening/usePubmedImport.ts`): `usePubmedDryRun(projectId)` and `useStartPubmedImport(projectId)` (mutations); `useImportRun(projectId, syncRunId: string | null)` (`enabled: Boolean(syncRunId)`, `refetchInterval` 2000 ms while `status` is `pending` or `running`, else `false`, as `frontend/hooks/extraction/useExtractionBatches.ts:35-39`; on reaching `completed` or `failed`, invalidate `screeningKeys.project(projectId)` once).
- Produces (component): `PubMedImportDialog({open, onOpenChange, projectId, canManage, onImportComplete}: {open: boolean; onOpenChange: (open: boolean) => void; projectId: string; canManage: boolean; onImportComplete?: () => void})` built on `AppDialog` (`frontend/components/patterns/AppDialog.tsx`); `onImportComplete` fires once when the run reaches `completed`.
- Produces (`frontend/lib/articlesListDisplay.ts`): `matchesSourceFilter(source: string | null | undefined, selected: readonly string[]): boolean` — `(source ?? 'MANUAL').toUpperCase()` in `selected`; `ArticlesList` uses it and gains `{value: 'PUBMED', label: t('articles', 'listSourcePubmed')}` (`articles.listSourcePubmed: 'PubMed'`).
- Mounting: "Import from PubMed" (`importOpen`) appears in `ScreeningHeader` and in both nothing-enrolled states, for every member (import role = membership, spec §13 decision 4); `ScreeningTab` takes `onImportComplete?: () => void` and forwards it.
- Errors map additions (`frontend/lib/screening/errors.ts`): `NCBI_EMAIL_NOT_CONFIGURED` → `errNcbiEmailMissing`, `SERVICE_UNAVAILABLE` → `errQueueUnavailable`, `VALIDATION_ERROR` → `errInvalidPmids`.

**Import dialog states (spec-gate #33) and copy:**

| State | Copy keys (`screening`) |
|---|---|
| input (tabs "Upload CSV" / "Paste PMIDs") | `importTitle: 'Import from PubMed'`, `importOpen: 'Import from PubMed'`, `importDescription: 'Upload the CSV PubMed exports, or paste PMIDs. Records are fetched from PubMed with their abstracts.'`, `importTabCsv: 'Upload CSV'`, `importTabPaste: 'Paste PMIDs'`, `importDropHint: 'Drop the PubMed CSV here, or choose a file'`, `importPastePlaceholder: 'One PMID per line, or separated by commas'`, `importCheck: 'Check'` |
| input errors (no request sent) | `errEmpty: 'No PMIDs found.'`, `errNoPmidColumn: 'This CSV has no PMID column.'`, `errInvalidPmids: 'These are not PMIDs: {{list}}'`, `errTooMany: 'Up to 10,000 PMIDs per import.'`, `errFileTooLarge: 'Files up to 25 MB.'` |
| dry run loading / error | `importChecking: 'Checking…'`; error → `screeningErrorMessage` |
| dry-run counts | `dryRunReceived: '{{n}} PMIDs'`, `dryRunAlready: '{{n}} already in this project'`, `dryRunNew: '{{n}} new'`, `dryRunRepeated: '{{n}} repeated in the list'`, `dryRunNothingNew: 'All of these PMIDs are already in this project. Importing again only fills missing fields.'`, `importConfirm: 'Import {{n}} PMIDs'` |
| start errors | `errNcbiEmailMissing: 'PubMed import is not configured on this server. Ask an administrator.'`, `errQueueUnavailable: 'The import queue is unavailable. Nothing was imported. Try again later.'`; 403 → `errorForbidden` |
| running | `importRunning: 'Importing… {{done}} of {{total}}'` (`done` = persisted + updated + skipped + failed) |
| completed | `importDone: 'Imported: {{inserted}} new, {{updated}} updated'`, `importNotFound: '{{n}} PMIDs were not found in PubMed or could not be fetched.'` (only when `failed > 0`), next step `importNextStepManager: 'Enroll the new articles to screen them.'` / `importNextStepMember: 'A project manager enrolls them for screening.'`, `importClose: 'Close'` |
| run failed | `importFailed: 'The import stopped. Articles imported so far are kept; you can import the same list again.'` |
| poll 404 | `importRunNotFound: 'This import is no longer available.'` |

- [ ] **Step 1: Add the dependencies**

```bash
cd "$WT" && npm install --save-exact papaparse@5.7.0 && npm install --save-exact --save-dev @types/papaparse@5.5.2
cd "$WT" && npm audit --omit=dev --audit-level=high
```
Expected: `package.json` lists `"papaparse": "5.7.0"` and `"@types/papaparse": "5.5.2"`; the audit exits 0.

- [ ] **Step 2: Write the failing tests.** `frontend/lib/screening/pmidInput.test.ts`:

```ts
it('parsePmidCsv finds a BOM-prefixed quoted PMID header')    // '﻿"PMID","Title"\n"42908551","A"\n"42875467","B"\n' → {ok: true, pmids: ['42908551', '42875467']}
it('parsePmidCsv reports a CSV without a PMID column')         // 'Title,DOI\nA,10.1/x\n' → {ok: false, error: 'no_pmid_column'}
it('parsePmidCsv refuses files over 25 MB without reading')    // size MAX_CSV_BYTES + 1 → 'file_too_large'; file.text never called
it('parsePmidText splits on whitespace, commas and semicolons and keeps repeats')  // '1, 2;3\n1' → ['1', '2', '3', '1']
it('parsePmidText lists invalid tokens')                       // '123 abc 45x' → {error: 'invalid', invalid: ['abc', '45x']}
it('parsePmidText caps at 10,000')                            // 10,000 tokens ok; 10,001 → 'too_many'
it('parsePmidText reports empty input')                        // '  \n ' → 'empty'
```

`PubMedImportDialog.test.tsx` (MSW, envelope bodies, fresh `QueryClient`, supabase/sonner mocks as Task 9's tests):

```ts
it('blocks input errors before any request')                  // paste '12 abc' → 'These are not PMIDs: abc'; Check disabled; no request (MSW errors on unhandled)
it('shows dry-run counts before importing')                   // POST body {pmids: ['1','2','2','3'], dry_run: true} → '4 PMIDs', '1 already in this project', '2 new', '1 repeated in the list'
it('says when nothing is new')                                // new 0 → dryRunNothingNew; confirm still enabled
it('shows a dry-run error')                                    // 500 → 'Something went wrong. Please try again.'
it('imports, shows progress, then the result')                 // 202 started → GET running (done 1 of 4) → completed {persisted 2, updated 0, skipped 1, failed 1}
                                                                //   → 'Imported: 2 new, 0 updated', '1 PMIDs were not found…', onImportComplete called once
it('explains a missing NCBI email')                            // 503 NCBI_EMAIL_NOT_CONFIGURED
it('explains an unavailable queue')                            // 503 SERVICE_UNAVAILABLE
it('reports a failed run')                                     // GET status failed → importFailed
it('reports a run that disappeared')                           // GET 404 → importRunNotFound
it('points a manager to enrollment and a member to the manager')  // canManage true/false on completion
```

`frontend/test/lib/articlesSourceFilter.test.ts`: `matchesSourceFilter('pubmed', ['PUBMED'])` true · `(null, ['MANUAL'])` true · `('zotero', ['PUBMED'])` false · `('RIS', ['RIS'])` true. `ScreeningTab.test.tsx`: add `it('offers PubMed import to members')` (non-manager, nothing enrolled → 'Import from PubMed' button opens the dialog).

- [ ] **Step 3: Run to see them fail**

Run: `cd "$WT" && npx vitest run frontend/lib/screening frontend/components/screening frontend/test/lib/articlesSourceFilter.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement** per the Interfaces block and the states table.

- [ ] **Step 5: Run the tests and the gates**

Run: `cd "$WT" && npx vitest run frontend/lib/screening frontend/components/screening frontend/components/articles frontend/test/lib frontend/test/ArticlesList.toolbar.test.tsx && npm run typecheck && npm run lint && npx knip --no-tag-hints && npx knip --production --no-tag-hints`
Expected: all pass; every command exits 0.

Run: `cd "$WT/backend" && for s in check_copy_keys check_react_query_keys check_frontend_data_path; do uv run python ../scripts/fitness/$s.py || exit 1; done`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add package.json package-lock.json frontend/lib/screening frontend/hooks/screening/usePubmedImport.ts frontend/components/screening frontend/services/screeningService.ts frontend/lib/query-keys/screening.ts frontend/lib/copy/screening.ts frontend/lib/copy/articles.ts frontend/pages/ProjectView.tsx frontend/lib/articlesListDisplay.ts frontend/components/articles/ArticlesList.tsx frontend/test/lib/articlesSourceFilter.test.ts
git -C "$WT" commit -m "feat(screening): import PubMed CSV or pasted PMIDs from the screening tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Screening queue, keyboard decisions, assignment view

**Seat:** frontend · **Depends on:** Task 9 (Task 10 only touches neighbouring files)

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Frontend tooling from `$WT` only — never `cd frontend && npm …`. Data path: component → hook → `frontend/services/screeningService.ts` (`ErrorResult<T>`, never throws or toasts) → `apiClient`; keys from `frontend/lib/query-keys/screening.ts`; the decision mutation invalidates `screeningKeys.project(projectId)` and `screeningKeys.assignment(assignmentId)`. Types from `frontend/types/api/schema.d.ts` (generated in Task 9). Strings via `t('screening', key)`; every key referenced; every file reachable (knip both modes at zero). The client never decides what is blind: it renders `peer_decisions` and `outcome` exactly as the API returns them. React Compiler: no `try/finally` or `throw` inside `try` in component/hook bodies; keyboard handling is a pure function plus one `useEffect` listener. Icon-only controls are `IconButton`; every control keeps a visible focus state. The post-edit hook strips unused imports. Fitness scripts run as `cd "$WT/backend" && uv run python ../scripts/fitness/<name>.py` (the system `python3` is 3.9).

**Files:**
- Create: `frontend/lib/screening/keymap.ts`, `frontend/hooks/screening/useScreeningQueue.ts`, `frontend/hooks/screening/useScreeningAssignment.ts`, `frontend/components/screening/ScreeningQueue.tsx`, `frontend/components/screening/AssignmentView.tsx`, `frontend/components/screening/DecisionButtons.tsx`
- Modify: `frontend/services/screeningService.ts`, `frontend/lib/query-keys/screening.ts`, `frontend/lib/screening/errors.ts`, `frontend/lib/copy/screening.ts`, `frontend/components/screening/ScreeningTab.tsx`
- Create: `frontend/lib/screening/keymap.test.ts`, `frontend/hooks/screening/__tests__/useScreeningQueue.test.tsx`, `frontend/components/screening/__tests__/ScreeningQueue.test.tsx`, `frontend/components/screening/__tests__/AssignmentView.test.tsx`; Modify: `frontend/components/screening/__tests__/ScreeningTab.test.tsx`

**Interfaces:**
- Consumes (Task 6 routes): `GET /api/v1/projects/{id}/screening/queue` → `ScreeningQueueRead` (`items` ≤ 20 in queue order, `awaiting_me`, `awaiting_others`, `exclusion_reasons`); `GET /api/v1/screening/assignments/{aid}` → `ScreeningAssignmentRead` (404 missing, 403 non-member); `POST /api/v1/screening/assignments/{aid}/decisions` body `ScreeningDecisionCreate` → `ScreeningAssignmentRead` (409 `SCREENING_REVIEWER_CAP` / `SCREENING_UNKNOWN_EXCLUSION_REASON` / `SCREENING_NOT_CONFIGURED`, 403 viewer).
- Produces (service): `fetchScreeningQueue(projectId)`, `fetchAssignment(assignmentId)`, `submitDecision(assignmentId, body: ScreeningDecisionCreate)`.
- Produces (keys): `screeningKeys.queue(projectId) = [...screeningKeys.project(projectId), 'queue']`; `screeningKeys.assignment(assignmentId) = [...screeningKeys.all, 'assignment', assignmentId]`.
- Produces (`frontend/lib/screening/keymap.ts`): `type ScreeningKeyAction = {kind: 'decide'; decision: 'include' | 'exclude' | 'maybe'} | {kind: 'open_reasons'} | {kind: 'reason'; index: number} | null`; `screeningKeyAction(event: {key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null}, reasonsOpen: boolean): ScreeningKeyAction` — `null` when a modifier is held or the target is an `input`, `textarea`, `select` or contenteditable; reasons closed: `1` include, `2` exclude, `3` maybe, `e`/`E` open_reasons; reasons open: `1`–`9` → `{kind: 'reason', index: n - 1}`; anything else `null` (Escape is the dialog's own).
- Produces (hooks): `useScreeningQueue(projectId, enabled: boolean)` (`useQuery` on `screeningKeys.queue`); `useDecide(projectId)` — `useMutation<ScreeningAssignmentRead, Error, {assignmentId: string; body: ScreeningDecisionCreate}, {previous?: ScreeningQueueRead}>` with `onMutate`: cancel the queue query, snapshot it, remove the item and decrement `awaiting_me` (optimistic advance); `onError`: restore the snapshot (rollback); `onSettled`: invalidate `screeningKeys.project(projectId)` and `screeningKeys.assignment(assignmentId)`. `useScreeningAssignment(assignmentId: string | null)`.
- Produces (components): `DecisionButtons({reasons, disabled, onDecide}: {reasons: string[]; disabled: boolean; onDecide: (body: ScreeningDecisionCreate) => void})` — Include / Exclude / Maybe / "Exclude with reason" (reasons listed numbered 1…n; hidden when `reasons` is empty), wired to `screeningKeyAction`; `ScreeningQueue({projectId})` — the current record (`items[0]`): title, `authors` · `journal_title` · `publication_year`, abstract or `noAbstract`, `DecisionButtons`, `remainingForYou`, a "Change last decision" link to `?assignment=<last decided id>`; `AssignmentView({assignmentId, canReview, onBack})`.
- `ScreeningTab` running state: a `?assignment=<id>` search param renders `AssignmentView` for any member (back clears the param); otherwise `can_review` renders `ScreeningQueue`. Errors map additions: `SCREENING_REVIEWER_CAP` → `errReviewerCap`, `SCREENING_UNKNOWN_EXCLUSION_REASON` → `errReasonsChanged` (also refetches the queue), `SCREENING_NOT_CONFIGURED` → `errNotConfigured`.

**States and copy (spec-gate #31, this task's share):**

| State | Copy keys (`screening`) |
|---|---|
| queue item | `decisionInclude: 'Include'`, `decisionExclude: 'Exclude'`, `decisionMaybe: 'Maybe'`, `excludeWithReason: 'Exclude with reason'`, `reasonsTitle: 'Exclusion reason'`, `keyboardHint: '1 include · 2 exclude · 3 maybe · E exclude with reason'`, `noAbstract: 'No abstract available'`, `remainingForYou: '{{n}} left for you'`, `changeLast: 'Change last decision'` |
| queue loading / error | `loading`; `ErrorState` with `loadErrorTitle` and retry |
| waiting on peers | items empty, `awaiting_others > 0`: `waitingTitle: 'Waiting on other reviewers'`, `waitingBody: '{{n}} records you screened are waiting for other reviewers or an arbitrator.'` |
| done | items empty, `awaiting_others === 0`: `doneTitle: 'All done'`, `doneBody: 'There is nothing left for you to screen.'` |
| decision 409s | toast: `errReviewerCap: 'This record already has all its reviewers.'`, `errReasonsChanged: "The protocol's exclusion reasons changed. Reload and pick again."`, `errNotConfigured: 'Screening is not set up for this project.'` |
| assignment view | `statusAwaitingMe: 'Waiting for your decision'`, `statusAwaitingOthers: 'Waiting for other reviewers'`, `statusConflict: 'Reviewers disagree'`, `statusDecided: 'Decided'`, `yourDecision: 'Your decision'`, `outcomeTitle: 'Outcome'`, `outcomeSolo: 'single reviewer'`, `outcomeConsensus: 'consensus'`, `outcomeArbitrated: 'arbitrated'`, `reasonsDiffer: 'Reviewers gave different reasons'`, `peerDecisionsTitle: 'Other reviewers'`, `backToQueue: 'Back to screening'` |
| assignment 404 / 403 | `ErrorState` with `errorNotFound` / `errorForbidden` and `backToQueue` |

- [ ] **Step 1: Write the failing tests.** `keymap.test.ts`:

```ts
it.each([['1', 'include'], ['2', 'exclude'], ['3', 'maybe']])('maps %s to %s', …)
it('opens reasons on e and E')
it('picks reason n-1 while reasons are open')               // '2' → {kind: 'reason', index: 1}
it('ignores keys with modifiers')                             // ctrlKey/metaKey/altKey → null
it('ignores keys typed into a text field')                    // target textarea → null
it('ignores unknown keys')                                    // 'x' → null
```

`useScreeningQueue.test.tsx` (`renderHook` inside a `QueryClientProvider`, MSW):

```ts
it('advances optimistically')        // queue [a1, a2], awaiting_me 2; mutate a1 while the POST handler is pending →
                                      // cached items == [a2], awaiting_me 1
it('rolls back when the decision fails')  // POST → 409 SCREENING_REVIEWER_CAP → cached queue equals the snapshot [a1, a2]
it('refetches the screening family after a decision')   // a GET queue request follows the settled POST
```

`ScreeningQueue.test.tsx`:

```ts
it('shows the current record with its abstract and the remaining count')
it('decides with the keyboard')                    // press '1' → POST body {decision: 'include'}
it('excludes with a numbered reason')              // reasons ['Wrong population', 'Not ML']; 'e' then '2' → {decision: 'exclude', exclusion_reason: 'Not ML'}
it('says when a record has no abstract')
it('says it is waiting on other reviewers')        // items [], awaiting_others 3 → 'Waiting on other reviewers', '3 records you screened…'
it('says all done')                                // items [], awaiting_others 0
it('shows the reviewer-cap message on 409')
it('shows the reasons-changed message on SCREENING_UNKNOWN_EXCLUSION_REASON')   // and the queue is refetched
it('links to the last decided record')             // after deciding a1 → link href contains 'assignment=a1'
```

`AssignmentView.test.tsx`:

```ts
it('renders not-found for a missing assignment')   // 404 → 'This record no longer exists.'
it('renders forbidden for a non-member')           // 403 → 'You do not have permission to do this.'
it('shows no peers while the record is blind')     // status awaiting_others, peer_decisions [] → no 'Other reviewers' section
it('shows the outcome and peers once decided')     // outcome consensus include, one peer → 'Outcome', 'consensus', peer name
it('lets a reviewer change the decision')          // canReview → click 'Exclude' → POST {decision: 'exclude'}; detail refetched
it('hides decision buttons from viewers')          // canReview false
```

`ScreeningTab.test.tsx`: add `it('gives reviewers the queue')` and `it('opens a record from ?assignment')`.

- [ ] **Step 2: Run to see them fail**

Run: `cd "$WT" && npx vitest run frontend/lib/screening/keymap.test.ts frontend/hooks/screening frontend/components/screening`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** per the Interfaces block and the states table (layout per the `frontend-ux` skill: the record is the content; buttons stay reachable without scrolling the abstract).

- [ ] **Step 4: Run the tests and the gates**

Run: `cd "$WT" && npx vitest run frontend/lib/screening frontend/hooks/screening frontend/components/screening && npm run typecheck && npm run lint && npx knip --no-tag-hints && npx knip --production --no-tag-hints`
Expected: all pass; every command exits 0.

Run: `cd "$WT/backend" && for s in check_copy_keys check_react_query_keys check_frontend_data_path; do uv run python ../scripts/fitness/$s.py || exit 1; done`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add frontend/lib/screening frontend/hooks/screening frontend/components/screening frontend/services/screeningService.ts frontend/lib/query-keys/screening.ts frontend/lib/copy/screening.ts
git -C "$WT" commit -m "feat(screening): keyboard-driven blind queue and record view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Conflicts panel and arbitration UI

**Seat:** frontend · **Depends on:** Task 11 (reuses `DecisionButtons`)

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Frontend tooling from `$WT` only — never `cd frontend && npm …`. Data path: component → hook → `frontend/services/screeningService.ts` (`ErrorResult<T>`, never throws or toasts) → `apiClient`; keys from `frontend/lib/query-keys/screening.ts`; the arbitration mutation invalidates `screeningKeys.project(projectId)` and `screeningKeys.assignment(assignmentId)`. Types from `frontend/types/api/schema.d.ts` (generated in Task 9). Strings via `t('screening', key)`; every key referenced; every file reachable (knip both modes at zero). React Compiler: no `try/finally` or `throw` inside `try` in component/hook bodies. Forms (the optional note) use react-hook-form + Zod. Icon-only controls are `IconButton`. The post-edit hook strips unused imports. Fitness scripts run as `cd "$WT/backend" && uv run python ../scripts/fitness/<name>.py` (the system `python3` is 3.9).

**Files:**
- Create: `frontend/hooks/screening/useScreeningConflicts.ts`, `frontend/components/screening/ConflictsPanel.tsx`
- Modify: `frontend/services/screeningService.ts`, `frontend/lib/query-keys/screening.ts`, `frontend/lib/screening/errors.ts`, `frontend/lib/copy/screening.ts`, `frontend/components/screening/ScreeningTab.tsx`
- Create: `frontend/components/screening/__tests__/ConflictsPanel.test.tsx`; Modify: `frontend/components/screening/__tests__/ScreeningTab.test.tsx`

**Interfaces:**
- Consumes (Task 7 routes): `GET /api/v1/projects/{id}/screening/conflicts` → `ScreeningConflictsRead` (`items: ScreeningConflictItem[]` with `assignment_id`, `article`, `decisions: PeerDecisionRead[]`; `exclusion_reasons: string[]`; 403 for non-arbitrators); `POST /api/v1/screening/assignments/{aid}/arbitration` body `ScreeningArbitrationCreate` → `ScreeningAssignmentRead` (409 `SCREENING_STALE_DECISIONS` / `SCREENING_NOT_IN_CONFLICT` / `SCREENING_UNKNOWN_EXCLUSION_REASON`, 404 for foreign decision ids). Task 11's `DecisionButtons({reasons, disabled, onDecide})`.
- Produces (service): `fetchConflicts(projectId): Promise<ErrorResult<ScreeningConflictsRead>>`, `submitArbitration(assignmentId, body: ScreeningArbitrationCreate): Promise<ErrorResult<ScreeningAssignmentRead>>`.
- Produces (keys): `screeningKeys.conflicts(projectId) = [...screeningKeys.project(projectId), 'conflicts']`.
- Produces (hooks, `useScreeningConflicts.ts`): `useScreeningConflicts(projectId, enabled: boolean)`; `useArbitrate(projectId)` (`useMutation<ScreeningAssignmentRead, Error, {assignmentId: string; body: ScreeningArbitrationCreate}>`; `onSettled` invalidates the project family and the assignment key — a stale or no-longer-in-conflict 409 therefore reloads the list).
- Produces (component): `ConflictsPanel({projectId})` — one card per conflict: article title, abstract (collapsible), each decision as reviewer name (`unnamedReviewer` when `reviewer_name` is null) + decision label + reason, a "Use {{name}}'s decision" button per decision (body `{ruled_on_decision_ids: <all ids on the card>, selected_decision_id: <that id>, rationale?}`), and "Decide differently" which reveals `DecisionButtons` with `exclusion_reasons` (body `{ruled_on_decision_ids, decision, exclusion_reason?, rationale?}`); an optional note field (`rulingNote`, max 2000) rides either body; success toast `rulingSaved`.
- `ScreeningTab` running state: when `can_arbitrate`, a segmented control `tabQueue` / `tabConflictsCount` (count = conflicts `items.length`) switches between `ScreeningQueue` (only if `can_review`) and `ConflictsPanel`; non-arbitrators never request conflicts. Errors map additions: `SCREENING_STALE_DECISIONS` → `errStaleDecisions`, `SCREENING_NOT_IN_CONFLICT` → `errNotInConflict`.

**States and copy (spec-gate #31, this task's share):** `tabQueue: 'Screen'`, `tabConflictsCount: 'Conflicts ({{n}})'`, `conflictsEmptyTitle: 'No conflicts to resolve'`, `conflictsEmptyBody: 'Records where reviewers disagree appear here.'`, `useDecisionOf: "Use {{name}}'s decision"`, `unnamedReviewer: 'A reviewer'`, `decideDifferently: 'Decide differently'`, `rulingNote: 'Note for the record (optional)'`, `rulingSaved: 'Conflict resolved'`, `errStaleDecisions: 'The decisions changed since you opened this conflict. It has been reloaded.'`, `errNotInConflict: 'This record is no longer in conflict.'`; loading → `loading`; load error → `ErrorState` with `loadErrorTitle`; 404 → `errorNotFound`.

- [ ] **Step 1: Write the failing tests.** `ConflictsPanel.test.tsx` (MSW, fresh `QueryClient`, supabase/sonner mocks as Task 9's tests):

```ts
it('lists each conflict with every reviewer decision')     // 1 item, decisions A include / B exclude 'Not ML' → names, labels, reason
it('resolves by choosing a reviewer decision')               // click "Use B's decision" → POST {ruled_on_decision_ids: ['dA', 'dB'], selected_decision_id: 'dB'}; toast 'Conflict resolved'
it('resolves by deciding differently with a reason and a note')
    // 'Decide differently' → 'Exclude with reason' → 'Wrong population', note 'Out of scope' →
    // POST {ruled_on_decision_ids: ['dA', 'dB'], decision: 'exclude', exclusion_reason: 'Wrong population', rationale: 'Out of scope'}
it('shows the empty state')                                  // items [] → 'No conflicts to resolve'
it('reloads on stale decisions')                             // 409 SCREENING_STALE_DECISIONS → message; a second GET conflicts follows
it('reloads when the record is no longer in conflict')       // 409 SCREENING_NOT_IN_CONFLICT → message; GET follows
it('shows the load error')                                   // 500 → 'Could not load screening'
```

`ScreeningTab.test.tsx`: add `it('gives arbitrators a conflicts tab with its count')` ('Conflicts (2)') and `it('never requests conflicts for a non-arbitrator')` (no GET to `/screening/conflicts`; MSW `onUnhandledRequest: 'error'` would fail it).

- [ ] **Step 2: Run to see them fail**

Run: `cd "$WT" && npx vitest run frontend/components/screening`
Expected: FAIL (`ConflictsPanel` not found).

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run the tests and the gates**

Run: `cd "$WT" && npx vitest run frontend/lib/screening frontend/hooks/screening frontend/components/screening && npm run typecheck && npm run lint && npx knip --no-tag-hints && npx knip --production --no-tag-hints`
Expected: all pass; every command exits 0.

Run: `cd "$WT/backend" && for s in check_copy_keys check_react_query_keys check_frontend_data_path; do uv run python ../scripts/fitness/$s.py || exit 1; done`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add frontend/hooks/screening/useScreeningConflicts.ts frontend/components/screening frontend/services/screeningService.ts frontend/lib/query-keys/screening.ts frontend/lib/screening/errors.ts frontend/lib/copy/screening.ts
git -C "$WT" commit -m "feat(screening): resolve screening conflicts as an arbitrator" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: PRISMA tab and the Playwright screening flow

**Seat:** frontend · **Depends on:** Tasks 8, 9, 11, 12

**Rules for this task:** worktree `WT=/Users/raphaelfedericcihaddad/PycharmProjects/prumo/.claude/worktrees/unruffled-kirch-2a8ec0`, `git -C "$WT"` only. English only. Frontend tooling from `$WT` only — never `cd frontend && npm …`. Data path: component → hook → `frontend/services/screeningService.ts` (`ErrorResult<T>`) → `apiClient`; keys from `frontend/lib/query-keys/screening.ts`. Types from `frontend/types/api/schema.d.ts` (generated in Task 9). Strings via `t('screening', key)`; every key referenced; every file reachable (knip both modes at zero; `frontend/e2e/**` counts only in default mode). Playwright: selectors by role, then label, then test id — no CSS/XPath; API calls go to `${loadE2EEnv().apiUrl}/api/v1/…`; a stateful flow owns its own project. Never apply `0094` to the shared local Supabase DB without coordinating, and roll it back (`cd "$WT/backend" && uv run alembic downgrade 0093_batch_agent_origin`) right after a local run; CI's ephemeral stack (`npm run test:e2e:local:core`) is the gate. Never `make db-fresh`/`reset-db`. The post-edit hook strips unused imports. Fitness scripts run as `cd "$WT/backend" && uv run python ../scripts/fitness/<name>.py` (the system `python3` is 3.9).

**Files:**
- Create: `frontend/hooks/screening/usePrismaCounts.ts`, `frontend/components/prisma/PrismaCountsPanel.tsx`
- Modify: `frontend/services/screeningService.ts`, `frontend/lib/query-keys/screening.ts`, `frontend/lib/copy/screening.ts`, `frontend/pages/ProjectView.tsx:253-254` (render `<PrismaCountsPanel projectId={projectId || ''} />`; drop the unused `FileBarChart` import), `frontend/components/layout/sidebarConfig.ts:57` (remove `comingSoon: true` from `prisma`)
- Create: `frontend/components/prisma/__tests__/PrismaCountsPanel.test.tsx`; Modify: `frontend/test/pages/ProjectView.screeningTabs.test.tsx`, `frontend/test/sidebar-screening-tabs.test.ts`
- Modify: `frontend/e2e/_fixtures/fixture-ids.ts`, `frontend/e2e/_fixtures/ensure-fixtures.ts` (export `login`, :45; provision the screening project in `ensureFixtures`, :138-191)
- Create: `frontend/e2e/_fixtures/screening.ts`, `frontend/e2e/flows/screening.ui.e2e.ts`

**Interfaces:**
- Consumes: `GET /api/v1/projects/{id}/prisma` → `PrismaCountsRead` (Task 8: `identified: {source, count}[]` with `pubmed` first, `identified_total`, `duplicates_removed`, `not_retrieved`, `imported_not_enrolled`, `screened`, `pending`, `in_conflict`, `excluded`, `excluded_by_reason: {reason, count}[]`, `excluded_reasons_differ`, `excluded_without_reason`, `sought_for_retrieval`; 403 for non-members). Task 9's `screeningErrorMessage`.
- Produces: `fetchPrismaCounts(projectId)`; `screeningKeys.prisma(projectId) = [...screeningKeys.project(projectId), 'prisma']` (every screening mutation already invalidates `screeningKeys.project`, so decisions, rulings, enrollment and import completion refresh it); `usePrismaCounts(projectId)`; `PrismaCountsPanel({projectId}: {projectId: string})`.
- Produces (e2e): `SCREENING_PROJECT_ID = "e2e00001-0000-4000-8000-000000000004"`, `SCREENING_ARTICLES = [{id: "f00dc63a-6b47-42c3-8a93-af69eb28a1c6", title: "E2E Screening Alpha"}, {id: "f00dc63a-6b47-42c3-8a93-af69eb28a1c7", title: "E2E Screening Beta"}] as const` in `fixture-ids.ts`; `resetScreeningProject(): Promise<void>` in `_fixtures/screening.ts` — `adminDelete("articles", "project_id=eq.<id>")` (FK cascades remove assignments, decisions and rulings as the table owner; no grant on the screening tables is needed), `adminUpdate("projects", "id=eq.<id>", {settings: {}})`, then `adminInsert("articles", …)` for both, each with a short abstract (`frontend/e2e/_fixtures/supabase-admin.ts:25-85`). `ensureFixtures` adds the project with owner `manager`, reviewers B and C `reviewer`, and both articles (`ensureProject`/`ensureMembership`/`ensureArticle`, :56-76).

**PRISMA tab states (spec-gate #32) and copy:**

| State | Renders |
|---|---|
| loading | skeleton, `aria-busy="true"`, sr-only `loading` |
| error | `ErrorState` title `loadErrorTitle`, message `screeningErrorMessage(error)` (403 → `errorForbidden`), retry |
| empty | `screened === 0`: `prismaEmptyTitle: 'No records screened yet'`, `prismaEmptyBody: 'Counts appear once articles are enrolled for screening.'`, plus the `prismaNotEnrolled` line when `imported_not_enrolled > 0` |
| counts | `prismaTitle: 'PRISMA counts'`; `prismaIdentification: 'Identification'` with one line per source (`prismaSourcePubmed: 'PubMed'`, `prismaSourceZotero: 'Zotero'`, `prismaSourceRis: 'RIS'`, `prismaSourceManual: 'Manual'`; any other source shows its raw value), `prismaIdentifiedTotal: 'Records identified'`, `prismaDuplicates: 'Duplicates removed'`, `prismaNotRetrieved: 'Records not retrieved from the source'`, `prismaNotEnrolled: 'Imported but not enrolled'`; `prismaScreening: 'Title and abstract screening'` with `prismaScreened: 'Records screened'`, `prismaPending: 'Awaiting decisions'`, `prismaInConflict: 'In conflict'`, `prismaExcluded: 'Records excluded'` (then one line per reason, `prismaReasonsDiffer: 'Reasons differ'`, `prismaNoReason: 'No reason given'`), `prismaSought: 'Sought for retrieval'`. Numbers only; the diagram is v2. |

- [ ] **Step 1: Write the failing unit tests.** `PrismaCountsPanel.test.tsx` (MSW, fresh `QueryClient`, supabase mock as Task 9's tests):

```ts
it('shows a busy region while loading')
it('shows the load error and retries')                         // 500
it('says forbidden for a non-member')                           // 403 → 'You do not have permission to do this.'
it('shows the empty state with the not-enrolled count')         // screened 0, imported_not_enrolled 3
it('renders identification and screening numbers')
    // identified [{pubmed, 3}, {ris, 1}], total 4, duplicates 1, not_retrieved 1, not enrolled 2, screened 3, pending 0,
    // in_conflict 0, excluded 2 by [{Not ML, 1}], reasons differ 1, no reason 0, sought 1 →
    // rows 'PubMed' 3, 'RIS' 1, 'Records identified' 4, 'Duplicates removed' 1, 'Records not retrieved from the source' 1,
    // 'Imported but not enrolled' 2, 'Records screened' 3, 'Records excluded' 2, 'Not ML' 1, 'Reasons differ' 1, 'Sought for retrieval' 1
```

`ProjectView.screeningTabs.test.tsx`: add the `?tab=prisma` case (mocked `PrismaCountsPanel` test id; no 'Coming soon'). `sidebar-screening-tabs.test.ts`: the `prisma` item's `comingSoon` is not `true`.

- [ ] **Step 2: Run to see them fail**

Run: `cd "$WT" && npx vitest run frontend/components/prisma frontend/test/pages/ProjectView.screeningTabs.test.tsx frontend/test/sidebar-screening-tabs.test.ts`
Expected: FAIL (`PrismaCountsPanel` not found; prisma still `comingSoon`).

- [ ] **Step 3: Implement** service, key, hook, panel, `ProjectView` and `sidebarConfig` changes.

- [ ] **Step 4: Run the unit tests and the gates**

Run: `cd "$WT" && npm run test:run && npm run typecheck && npm run lint && npx knip --no-tag-hints && npx knip --production --no-tag-hints`
Expected: the whole Vitest suite passes; every command exits 0.

Run: `cd "$WT/backend" && for s in check_copy_keys check_react_query_keys check_frontend_data_path; do uv run python ../scripts/fitness/$s.py || exit 1; done`
Expected: exit 0.

- [ ] **Step 5: Write the Playwright flow** `frontend/e2e/flows/screening.ui.e2e.ts` (runs in the `local-ui` project, which matches `flows/**/*.ui.e2e.ts`, `playwright.config.ts:89-101`; its own project keeps it out of `local-hitl`):

```ts
test.describe.configure({mode: 'serial'});
test.beforeAll(async () => { await resetScreeningProject(); });

test('screens, resolves a conflict and reads PRISMA', async ({browser}) => {
  // 1. owner (loginViaUiAs, OWNER_EMAIL): /projects/<SCREENING_PROJECT_ID>?tab=screening → choose '2 reviewers' → Save
  //    → 'Enroll all articles' → header shows '2 enrolled'
  // 2. reviewer B (new context, loginViaUiAs REVIEWER_B_EMAIL): same URL → press '1', then '1' → 'Waiting on other reviewers'
  // 3. reviewer C by API (token = await login(REVIEWER_C_EMAIL, FIXTURE_PASSWORD)): GET …/screening/queue → 2 items;
  //    POST …/decisions include on Alpha's assignment, exclude on Beta's (authHeaders from _fixtures/api.ts)
  // 4. owner: 'Conflicts (1)' → card titled 'E2E Screening Beta' → "Use E2E Reviewer Cora's decision" → 'No conflicts to resolve'
  // 5. owner: /projects/<SCREENING_PROJECT_ID>?tab=prisma → 'Manual' 2, 'Records identified' 2, 'Duplicates removed' 0,
  //    'Records screened' 2, 'Records excluded' 1, 'Sought for retrieval' 1
});
```

Rerunnable on a persisted database: the reset deletes and recreates the articles and clears `projects.settings`, so a second run starts unconfigured with an empty queue.

- [ ] **Step 6: Run the flow** — locally only if the shared Supabase stack is up and you have coordinated the temporary `0094` upgrade; otherwise leave it to CI and say so in your report.

Run (local): `cd "$WT/backend" && uv run alembic upgrade head` against the shared DB, start the worktree's servers, then `cd "$WT" && npx playwright test frontend/e2e/flows/screening.ui.e2e.ts --project=local-ui --repeat-each=2 --workers=1`, then `cd "$WT/backend" && uv run alembic downgrade 0093_batch_agent_origin`.
Expected: 2 passed (the repeat proves rerunnability).

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add frontend/hooks/screening/usePrismaCounts.ts frontend/components/prisma frontend/services/screeningService.ts frontend/lib/query-keys/screening.ts frontend/lib/copy/screening.ts frontend/pages/ProjectView.tsx frontend/components/layout/sidebarConfig.ts frontend/test/pages/ProjectView.screeningTabs.test.tsx frontend/test/sidebar-screening-tabs.test.ts frontend/e2e/_fixtures/fixture-ids.ts frontend/e2e/_fixtures/ensure-fixtures.ts frontend/e2e/_fixtures/screening.ts frontend/e2e/flows/screening.ui.e2e.ts
git -C "$WT" commit -m "feat(screening): PRISMA counts tab and the end-to-end screening flow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Verification

Run after Task 13, from the worktree; each must pass before the PR.

```bash
cd "$WT/backend" && uv run alembic upgrade head && uv run alembic check          # No new upgrade operations detected.
cd "$WT/backend" && uv run pytest tests/ -q -p no:randomly                        # = N passed, 0 failed (dedicated DB, Task 1 bootstrap)
cd "$WT" && npm run test:run && npm run typecheck && npm run lint
cd "$WT" && npx knip --no-tag-hints && npx knip --production --no-tag-hints
cd "$WT" && npm run generate:api-types && git -C "$WT" diff --exit-code frontend/types/api   # contract is current
make -C "$WT" quality-scan
```

**Spec §12 (slice A) and §8 checks → tests**

| Requirement | Test (task) |
|---|---|
| PubMed XML → normalized record | `test_structured_abstract_record`, `test_unstructured_abstract_and_own_pmc_only`, `test_letter_without_abstract`, `test_markup_and_non_ascii_survive`, `test_pubdate_variants`, `test_collective_author_and_doi_from_article_id_list` (2) |
| Identity match order | `test_pmid_wins_over_doi`, `test_falls_back_to_doi_then_url`, `test_zotero_key_short_circuits`, `test_lookup_is_project_scoped` (3; integration because the DOI key is SQL) |
| Fill-only update on a match (NULL and blank) | `test_fill_only_upsert_fills_blanks_and_keeps_provenance[zotero/RIS]` (3) |
| Outcome derivation table of §7 | `test_screening_outcome.py` table, 12 rows (6) |
| PRISMA checks of §8 | `test_pubmed_only_import_identified_equals_screened` (1,976 scaled to the 3-record fixture), `test_pubmed_matching_a_ris_article_counts_one_duplicate`, `test_reimporting_the_same_file_changes_nothing` (8; integration — the counts are read from event rows, so a mocked unit test would test past the interface); `test_prisma_screening_box.py` (8, unit) |
| Import idempotency | `test_reimport_updates_and_inserts_nothing`, `test_rerunning_the_same_run_duplicates_nothing` (4) |
| `dry_run` writes nothing and calls no NCBI | `test_dry_run_counts_and_writes_nothing`, `test_dry_run_needs_no_ncbi_email`, `test_handler_dry_run_returns_counts` (4) |
| Concurrent overlapping imports create no duplicate | `test_concurrent_overlapping_imports_create_no_duplicate_article` (4) |
| A PubMed match keeps Zotero/RIS `ingestion_source` and `source_payload` | `test_pubmed_match_keeps_the_existing_provenance[zotero/RIS]` (4) |
| Sync run counts | `test_run_import_writes_one_event_per_received_pmid`, `test_run_counts_mapping` (4) |
| Solo, dual, 3-reviewer outcomes | `test_solo_outcome`, `test_dual_blind_until_consensus`, `test_three_reviewers` (6) |
| Two reviewers deciding concurrently → consensus | `test_two_reviewers_deciding_at_once_reach_consensus`, `test_cap_holds_when_three_reviewers_decide_at_once` (6) |
| Reviewer beyond `reviewer_count` → 409 | `test_reviewer_beyond_cap_is_409` (6) |
| Arbitration on stale ids / not in conflict → 409 | `test_stale_decision_ids_are_409`, `test_not_in_conflict_is_409` (7) |
| Forged `selected_decision_id` refused | `test_forged_selected_decision_is_refused` (7) |
| Reviewer change after a ruling keeps the ruling | `test_reviewer_change_after_a_ruling_leaves_it_in_force` (6), outcome row `ruling-stands` (6) |
| `reviewer_count` change after the first decision → 409 | `test_reviewer_count_frozen_after_first_decision` (5) |
| Blind masking in the read path | `test_dual_blind_until_consensus`, `test_conflict_is_hidden_from_reviewers_and_shown_to_arbitrators` (6) |
| Reviewer vs viewer on the decision route | `test_viewer_reads_but_cannot_decide` (6) |
| Enroll is idempotent | `test_enroll_all_is_idempotent`, `test_enroll_selected` (5) |
| RLS: no client privilege on screening tables; no client writes on sync tables | `test_screening_tables_are_deny_all`, `test_sync_tables_refuse_client_writes` (1) |
| PostgREST read as `authenticated` → permission denied | `test_screening_read_as_authenticated_is_permission_denied` (1) |
| `not_found` PMIDs are not duplicates | `test_not_found_pmids_are_not_duplicates` (8) |
| Imported but not enrolled is not identified | `test_imported_but_not_enrolled_is_not_identified` (8) |
| Queue hook (optimistic advance, rollback) | `useScreeningQueue.test.tsx` (11) |
| Keyboard map | `keymap.test.ts` (11) |
| Import dialog counts | `PubMedImportDialog.test.tsx` › 'shows dry-run counts before importing' (10) |
| Playwright: enroll → decide → resolve a conflict → PRISMA | `frontend/e2e/flows/screening.ui.e2e.ts` (13) |

Deferred to slice B: "a later enrollment does not shrink the calibration prefix" (calibration is slice B), quote verification, Wilson interval, suggestion CHECKs and every slice-B integration case.

**Spec-gate #34 (slice A) → tests**

| Requirement | Test (task) |
|---|---|
| §4.1 imports GET guard; non-member refused | `test_poll_is_bound_to_project_and_requester`, `test_import_requires_membership` (4) |
| §4.1 efetch batches of 200, serial, ≤ 3 req/s | `test_batches_are_serial_and_at_most_200` (4), `test_efetch_spaces_requests_at_most_three_per_second` (2) |
| §4.1 `tool` and `email` parameters | `test_efetch_sends_etiquette_and_ids` (2) |
| §4.1 `duplicate_in_request` and `failed` statuses | `test_run_import_writes_one_event_per_received_pmid`, `test_ncbi_failure_fails_its_batch_and_continues` (4) |
| §4.1 dry-run count values | `test_dry_run_counts_and_writes_nothing` (4) |
| §4.2 DOI stored with a prefix | `test_doi_match_ignores_stored_prefix_and_case` (3) |
| §5 `0094` downgrade | `test_migration_0094_screening_v1_roundtrip` (1) |
| §7 queue contents (≤ 20, order, excludes awaiting-peer and ruled) | `test_queue_contents_and_order` (6) |
| §7 `exclusion_reason` limited to the protocol's strings | `test_unknown_exclusion_reason_is_refused` (6), `test_override_reason_must_be_in_the_protocol` (7) |
| §7 arbitrators see the conflicting decisions | `test_conflict_is_hidden_from_reviewers_and_shown_to_arbitrators` (6), `test_conflicts_list_for_arbitrators` (7) |
| §9 manager-only routes (enroll, PUT config) | `test_put_config_requires_manager`, `test_enroll_requires_manager` (5) |
| §9 arbitrator-only routes (conflicts, arbitration) | `test_conflicts_list_for_arbitrators`, `test_reviewer_cannot_arbitrate` (7) |
| §9 enroll refuses a foreign `article_id` | `test_enroll_refuses_a_foreign_article` (5) |
| §9 `load_assignment_for_member` refuses another project's assignment | `test_outsider_and_foreign_assignment` (6) |
| §10 tab states | `ScreeningTab.test.tsx` (9–12), `ConflictsPanel.test.tsx` (12), `AssignmentView.test.tsx` (11), `PrismaCountsPanel.test.tsx` (13) |
| §10 PubMed source filter option | `articlesSourceFilter.test.ts` (10) |

**PR notes (for the orchestrator)**
- Known limitation (spec-gate #11, ruled): `articles` stays member-writable through PostgREST, so a member can relabel an article's `ingestion_source` and skew PRISMA's "other sources" line; the PubMed line reads closed sync events and is unaffected.
- Human step (ruling #19): set `NCBI_EMAIL` on Railway for the backend AND the worker before the first non-dry-run import.
- Post-merge validation, not a gate: the 1,976-record MIMIC-IV export through import, enrollment and blind screening.
- Ledger ruling: do not open the PR or arm auto-merge until #1052 is merged on `dev`.
