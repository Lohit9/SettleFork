# Connector framework — architecture and design

**Status:** Approved for implementation (founder review 2026-04-23)  
**Audience:** Engineering, security, enterprise customers, technical investors  
**Non-goals:** EBCDIC/dedup/Cluster A–C work (separate docs); implementation code (this document only)

---

## 1. Scope summary

### What the framework covers

- A **unified connector model** for ingestion (sources) and delivery (targets), sharing **credentials**, **schema introspection contracts**, **staging / re-import semantics**, **job lifecycle**, and **observability**.
- **Connector categories:**
  1. **SaaS API** — Salesforce (launch target), HubSpot, Dynamics, NetSuite, Workday (future).
  2. **Database** — PostgreSQL, MySQL, SQL Server (today via `db_connections` / `lib/actions/db-connector.ts`; migrated into unified `connections` + `connector_credentials`), future Snowflake/Oracle.
  3. **File** — CSV, DDL, schema docs (today), Excel, future EBCDIC/fixed-length, JSON/XML/Parquet.
  4. **Specialized** — agent-based on-prem (future).
  5. **Export artifact** — SQL load scripts and execution packages (today via `lib/actions/_outputs-core.ts`, `lib/actions/execution-package.ts`; adapters behind `ExportArtifactTarget`).

### What it does not cover (v1 of this doc)

- File-format specifics for EBCDIC/fixed-length (separate design).
- Dedup/clustering algorithms.
- Replacing the mapping redesign data model — connectors integrate at **dataset / connection / job** boundaries.

### Launch vs future

| Category         | Launch                                                                 | Future                                              |
|-----------------|-------------------------------------------------------------------------|-----------------------------------------------------|
| SaaS API        | **Salesforce target** (Inngest-backed jobs, OAuth per Section 7)        | HubSpot, Dynamics, NetSuite, Workday                |
| Database        | **Unified `connections`** after migration from `db_connections`       | Snowflake, Oracle, richer sync modes                |
| File            | Existing CSV / DDL / schema-doc flows (adapter pattern)                 | EBCDIC, fixed-length, Parquet, etc.                 |
| Specialized     | —                                                                       | On-prem agent                                       |
| Export artifact | Framework interface beside legacy SQL generators (Medium-scope path)   | Informatica, SSIS, dbt, Python ETL                  |

**Job execution:** **Inngest** (Section 4). **UX:** Salesforce is a **fourth peer** in the existing ingestion-method control on the Source/Target card (`IngestionCard.tsx`), not nested under Database Connection. **Feature flag:** project-level `use_connector_framework` (Section 8).

---

## 2. Founder decisions (2026-04-23)

1. **Job runner: Inngest** — Free tier early, paid as we scale; vendor maintains **SOC 2 Type II**. HTTP handlers on Vercel enqueue Inngest events and return immediately (within **60s** limits). Workers run **outside** the request lifecycle; each **step** fits per-invocation limits while the **overall job** may run for hours via step chaining.

2. **`db_connections` relationship: Option 1, full migration** — New **`connections`** and **`connector_credentials`** tables replace **`db_connections`** (`supabase/migrations/045_db_connections.sql`) and any legacy “connector_credentials” sketch from the old Database Connectors PDF. A **backfill migration** moves existing `db_connections` rows into the new model. **`lib/actions/db-connector.ts`** (~1,487 LOC) refactors to read/write **`connections`** / **`connector_credentials`** only. **Test coverage audit:** there are **no** dedicated unit or integration tests under `tests/` that import `db-connector` or `saveConnectionAndIntrospect` today (grep across `tests/` finds no matches). **Before refactor:** add **parity / integration tests** so the flag-guarded deploy is safe; treat test development as a **gating** work item, not optional.

3. **Credentials storage: `connector_credentials` table** — **AES-256-GCM**, reusing the operational pattern from `lib/utils/encryption.ts` (`aes-256-gcm`, `iv:authTag:ciphertext` string format today; new table stores **binary** `ciphertext`, `iv`, `auth_tag` columns for clarity and to match rotation). Columns: `id`, `org_id`, `kind`, `ciphertext` (bytea), `iv` (bytea), `auth_tag` (bytea), `key_version`, `created_at`, `rotated_from` (FK self-ref for rotation chain audit), `expires_at`, `revoked_at`. **RLS:** writable only by **service role** + **platform admins**; readable when joined through a **`connections`** row the user may access. **`org_id` on the credential row** for defense-in-depth (not only transitive from `connections`).

4. **`connections` schema** — Columns: `id`, `org_id`, `project_id`, `dataset_id`, `connector_id`, `connector_version`, `display_name`, `status` (`pending` / `active` / `error` / `revoked`), `config` jsonb (non-secret; includes **Salesforce API version** pin per connection for audit/migration), `credential_id` (FK → `connector_credentials`), `last_health_check_at`, `last_error` jsonb (**normalized** `ErrorEnvelope`, Section 10), `created_by`, `created_at`, `updated_at`. Indexes on `project_id`, `org_id`, `connector_id`. **RLS:** `SELECT` via `user_can_access_project(project_id)`; **write** via `user_has_project_role(project_id, 'editor')`; platform operations via `is_platform_admin` where appropriate (signatures: `050_organizations.sql`, `068_platform_admins.sql`).

5. **OAuth model: Settle-registered Connected App (v1 default)** — Eight hardening measures are **non-negotiable:** **PKCE**; **state** validation via **opaque server-side session** (not hand-rolled crypto in the state param); **redirect URI allowlisting**; **minimal scopes** — **`api` + `refresh_token` + `offline_access` only** (never `full`, never `web`, never `chatter_api`); **refresh token rotation** consistent with OAuth 2.1 expectations; **encrypted-at-rest** credentials with **redaction discipline** (Section 10); **`expires_at` + proactive refresh**; Connected App settings: **Enforce IP restrictions**, **Require secret for Web Server Flow / refresh token flow** as applicable, **refresh token lifetime** aligned with **90-day inactivity** policy, **session policy = high assurance**. **BYO Connected App:** designed into **schema** and **connector interface** (`config` / `credential` variants); **v1.5** fast-follow when the first enterprise customer requires it.

6. **Salesforce object scope at launch** — **Standard + custom (`__c`)** with sensible filters. Default **“Recommended”** view hides system noise (`*History`, `*Share`, `*Feed`, `*Tag`, Apex*, setup/metadata noise, `deprecatedAndHidden`). **“Show all objects”** exposes the full list. **Namespace-aware grouping:** detect **every** namespace prefix present (`rstk__`, `npsp__`, `FF__`, `vlocity_ins__`, etc.) and render **grouped sections**: Standard / Custom (org-built) / **one section per detected managed-package namespace** with label resolved from **package metadata** (no ISV-specific code paths). **Big Objects** and **External Objects:** **v1 deferred** — detected, listed **grayed** with “not yet supported” tooltip. **Custom Settings:** hidden from Recommended; in full view labeled **“(setting)”**. **Person Accounts:** supported with **documented** schema quirks in connector docs (duplicate contact/account patterns).

7. **Edition support** — **Floor: Enterprise edition and above**, plus all **Developer / Partner DE** orgs suitable for demo. **Hard block at OAuth callback:** if `/services/data/vXX/sobjects` or `/limits` (or equivalent) indicates **unsupported edition** or **no Bulk API 2.0 access**, abort **before** inserting `connections` or storing credentials — **no orphan credentials**. Redirect to error page with reason **`unsupported_edition`**. **Demo target = sandbox.** Surface **edition + API limits** on the inline connection card (e.g. “Connected to Acme Salesforce Enterprise — 87,234 / 1,000,000 daily API calls remaining”).

8. **API version** — Pin **`v63.0`** at launch. At implementation time: verify **v63** is still GA and **≥6 months** mature; if retired, bump to the **current stable** pin (e.g. v64) and update **`SALESFORCE_API_VERSION`** + this doc in the same PR. **Annual review every January.** Version is **connector-module-scoped:** `SALESFORCE_API_VERSION` constant in Salesforce connector config; all URL builders consume it. **Source-invariant test:** `tests/lib/salesforce-api-version-guard.test.ts` greps for `/services/data/v\d+\.\d+/` outside the allowed constant file and **fails** on drift. **`connections.config`** stores the API version per connection for audit and migration support.

9. **Failure round-trip (Salesforce target push)** — **Visibility:** each rejected row → **`quality_issues`** with `stage = 'target'`; severity from Salesforce error category (**blocking** for validation/required-field; **warning** for softer issues such as duplicate-detection); structured description with SF code/message/field path; **PII stripped** from persisted text — reference **`staged_data_rows.id`** instead. **Retry safety:** extend **`staged_data_rows`** with `target_push_status` (`pending` / `in_flight` / `succeeded` / `failed`), `target_push_attempted_at`, `target_push_error_id` (FK → `quality_issues`), `target_external_id` (Salesforce Id after success). Re-push filters **`target_push_status IN ('pending', 'failed')`** — successes skipped. **Audit:** **`connector_job_steps`** — **event-sourced**, **append-only**: each step’s lifecycle is a **sequence of inserted events** (`started`, `completed`, `failed`, `retried`). **No `UPDATE`** on step events; current state = **latest event** per `(connector_job_id, step_index)`. **DB permissions:** application role **INSERT-only** on `connector_job_steps`; **no UPDATE/DELETE** for that role; a **more privileged role** used **only** by retention cleanup. Step events store **`request_summary`** / **`response_summary`** (not raw bodies): HTTP method, path, byte counts, status code, selected safe headers; Salesforce job IDs in **`metadata` jsonb**; errors as structured **`ErrorEnvelope`** after normalization. **Bulk correlation:** every Bulk CSV includes **`_settle_row_id`** = `staged_data_rows.id`; Salesforce echoes in success/failure result CSVs; framework correlates on that column; **hidden** from mapping UI. **Retention:** **2 years** `connector_job_steps` events; **7 years** `connector_jobs` summary; **`quality_issues`** indefinite. Cleanup via **scheduled Inngest**; per-org retention config is **v2**. **Edge cases:** partial batch failure is **normal** (job completes with non-empty `failedResults`); **job-level failure** → revert in-flight rows to **`pending`**; **network failure mid-poll** → Inngest step retries; **idempotency** via `target_push_status` on success path; **source data mutation after successful push** → row returns **`pending`** while **preserving** `target_external_id` until intentionally cleared.

10. **External ID strategy** — **`INSERT`-then-upsert-by-Id**; **no** customer-side external-ID fields in v1. First push: **composite `create` / Bulk insert**; capture returned **Salesforce Ids** into `staged_data_rows.target_external_id`. Subsequent pushes: **upsert by Id** (universal). New rows repeat the pattern. Customer-defined external IDs → **v2 advanced option**. OAuth scopes remain **`api` + `refresh_token` + `offline_access`** only — **no** `modify_metadata` / `full`.

11. **Logger redaction — four layers** — **Layer 1:** `Secret<T>` brand type in `lib/connector-framework/secret.ts`, **WeakMap-backed** so values **do not survive `structuredClone()`** (Inngest step persistence). `toString`, `toJSON`, `util.inspect` → `'[REDACTED]'`; **`.unwrap()`** is grep-auditable; decryption returns **`Secret<string>`**, never bare string. **Layer 2:** **`connectorLogger`** only inside connector modules; pipeline redacts known keys (`access_token`, `refresh_token`, `client_secret`, `password`, `api_key`, `code`, `auth_tag`, `iv`), known value shapes (session id, JWT, OAuth code), and any **`Secret<T>`**. **Layer 3:** **`normalizeErrorEnvelope()`** before persisting to `connector_job_steps.error`, `connections.last_error`, or UI — same pipeline plus strip **`Authorization` / `Cookie` / `X-API-Key`**, truncate long strings. **Layer 4:** source-invariant tests: `connector-logger-only.test.ts`, `secret-unwrap-audit.test.ts` (report-only unwrap count), `error-normalization-coverage.test.ts`. **No** DB CHECK constraint for secret detection (performance, false positives, audit loss). **Instead:** **nightly Inngest scan** over audit columns for credential-like patterns → **alert** if found (SOC 2–friendly). **No dev-mode bypass.** **Rule:** **`Secret<T>` never crosses an Inngest step boundary** — unwrap inside the step, perform HTTP, persist **redacted summaries** only.

12. **OAuth callback specifics** — **`oauth_flow_sessions`:** `id`, `opaque_token` (base64url, maps to `state` param), `user_id`, `project_id`, `connector_id`, `redirect_uri`, `pkce_verifier`, `expires_at`, `redeemed_at`, `created_at`; **TTL 5 minutes**; cleanup via Inngest schedule. **Token exchange:** **one attempt**, **15s timeout**, **no retries** (codes single-use). Strict schema validation on token response. **`redeemed_at`:** first success marks redeemed; second callback → **`state_already_redeemed`** regardless of IP. **Rate limits:** Postgres-backed **10 req/IP/min**, **100 req/IP/hour**, **429** with no hint about code validity. **Success:** `app/app/projects/[projectId]/connections/[connectionId]/success/page.tsx` — name, edition, limits; **health check completes in callback** before redirect. **Errors:** single route `?reason=` with codes: `invalid_state`, `expired_state`, `state_already_redeemed`, `unsupported_edition`, `oauth_denied`, `token_exchange_failed`, `health_check_failed` — **no** raw error text in URL. **Callback:** `app/api/auth/connectors/[connectorId]/callback/route.ts`.

13. **UX migration** — Salesforce is a **fourth peer** in the **“Data ingestion method”** dropdown on the Source/Target card (`IngestionCard.tsx`), peer to **CSV Upload**, **DDL Schema Upload**, **Database Connection**. **Not** under Database Connection. **No** separate Connections page. **Inline** connected state: display name, edition, API limits, last sync, actions **Re-sync / Disconnect / Reconnect**. Dropdown section headers deferred until **>6–8** options.

14. **Feature flag** — **`projects.use_connector_framework BOOLEAN NOT NULL DEFAULT FALSE`**, mirroring `use_mapping_redesign` / `maintenance_mode` pattern (`073_mapping_redesign_feature_flag.sql`). **Default FALSE** — new projects do not auto-opt-in. Gate at **Project Setup page** boundary, not scattered guards. **Heritage Core canary** → gradual rollout → default **TRUE** → **single cleanup migration** drops column + legacy dispatch + **`db_connections`** code paths together when fully rolled out.

---

## 3. Current state (codebase evidence)

### 3.1 Ingestion UI

- Project setup / ingestion lives under **`app/app/projects/[projectId]/project/`** — `ControlPlaneContent.tsx`, **`IngestionCard.tsx`** (wires CSV, DDL, DB connector). There is **no** `control-plane/` directory in this repo.
- **CSV:** `uploadCSV` in `lib/actions/csv.ts` — validates, parses (PapaParse), infers fields, inserts **`tables`**, **`fields`**, **`data_rows`**. ```19:195:/Users/kaandincer/dev/settle/lib/actions/csv.ts```
- **DDL:** `parseDDLFile` / `confirmDDLSchema` in `lib/actions/ddl-upload.ts` — schema-only for confirm (no `data_rows`). ```107:175:/Users/kaandincer/dev/settle/lib/actions/ddl-upload.ts```
- **Schema docs:** `uploadSchemaDocument` in `lib/actions/schema-documents.ts` — storage + optional DDL merge / AI conversion. ```16:199:/Users/kaandincer/dev/settle/lib/actions/schema-documents.ts```
- **Database:** `lib/actions/db-connector.ts` + **`app/api/db-import/route.ts`** (`maxDuration = 60`). ```1:4:/Users/kaandincer/dev/settle/app/api/db-import/route.ts```

### 3.2 Staging and row storage

- Raw ingested rows: **`data_rows`** with **`row_data` JSONB**, FK **`table_id`**. ```51:56:/Users/kaandincer/dev/settle/supabase/migrations/002_foundation.sql```
- Mapped migration staging: **`staged_data_rows`** — `source_row_data`, `transformed_row_data`, `table_mapping_id`. ```8:17:/Users/kaandincer/dev/settle/supabase/migrations/013_staged_data_rows.sql```
- **Founder decisions** add **`staged_data_rows` target-push columns** and **`_settle_row_id`** Bulk correlation (Section 6 / 9) — not present in codebase at time of this doc.

### 3.3 Outputs / SQL artifacts

- **Migration Center:** `app/app/projects/[projectId]/outputs/page.tsx` → `getOutputsPageData`. ```12:64:/Users/kaandincer/dev/settle/app/app/projects/[projectId]/outputs/page.tsx```
- **Gold-standard SQL:** `generateSQLLoadScriptsInternal` in `lib/actions/_outputs-core.ts` reads **`staged_data_rows`** or RPC `execute_gold_standard_query`. ```538:645:/Users/kaandincer/dev/settle/lib/actions/_outputs-core.ts```
- **Execution package (AI SQL):** `lib/actions/execution-package.ts` — separate path, still an export artifact candidate for adapter pattern.

### 3.4 Encryption (today)

- **`lib/utils/encryption.ts`:** AES-256-GCM, `DB_ENCRYPTION_KEY` (64 hex chars). ```1:34:/Users/kaandincer/dev/settle/lib/utils/encryption.ts```

### 3.5 Async (today)

- **Vercel Cron:** `vercel.json` → `/api/cron/auto-archive`. ```1:8:/Users/kaandincer/dev/settle/vercel.json```
- **Cron handler:** `maxDuration = 300`, `CRON_SECRET` auth. ```1:10:/Users/kaandincer/dev/settle/app/api/cron/auto-archive/route.ts```
- **AI:** `callClaude` / `callClaudeStreaming` in `lib/ai/claude.ts`. ```10:53:/Users/kaandincer/dev/settle/lib/ai/claude.ts```

### 3.6 Types

- **`Dataset.role`:** `'source' | 'target'`. ```22:28:/Users/kaandincer/dev/settle/lib/types/database.ts```
- **`DBConnection`:** includes `password_encrypted` — **superseded by unified model** after migration (Section 8). ```381:396:/Users/kaandincer/dev/settle/lib/types/database.ts```

### 3.7 RLS helpers (signatures)

- **`user_can_access_project(p_project_id UUID)`**, **`get_user_project_role(p_project_id UUID, p_user_id UUID)`**, **`user_has_project_role(p_project_id UUID, p_min_role VARCHAR(20))`** — ```134:166:/Users/kaandincer/dev/settle/supabase/migrations/050_organizations.sql```
- **`is_platform_admin(check_user_id UUID)`** — ```61:71:/Users/kaandincer/dev/settle/supabase/migrations/068_platform_admins.sql```

### 3.8 Migrations

- Latest numbered migration in repo at author time: **`075_target_field_mapping_needs_transformation.sql`**. New framework migrations will follow **`076+`** (exact number assigned at implementation).

---

## 4. Job runner selection

| Option            | Role in Settle                                                  |
|------------------|------------------------------------------------------------------|
| Vercel Cron      | **Supplemental** only (e.g. housekeeping), not primary job queue |
| Inngest          | **Primary** durable orchestration for connector jobs             |
| Trigger.dev      | Not selected for v1                                              |
| DIY Supabase     | Not selected for v1                                              |

### Decision: Inngest

- **Rationale:** Managed **SOC 2 Type II**, **step-level** retries, observability, and **separation** from Vercel’s HTTP timeout surface. Handlers **emit events** and **return quickly**; workers execute **multi-hour** workflows as **chained steps**, each step respecting **per-invocation** limits. **No open question** — this is the locked decision.

---

## 5. Core abstractions (TypeScript)

*Syntactically valid sketches for lift into `lib/connector-framework/`.*

### 5.1 `Secret<T>` (Layer 1)

```typescript
/** Opaque handle — plaintext never stored on the object’s enumerable fields. */
export interface Secret<T> {
  /** Grep-auditable — only call at HTTP/SDK boundaries inside a single Inngest step. */
  unwrap(): T
  toJSON(): '[REDACTED:secret]'
}

/** Internal vault — not exported. structuredClone(secret) yields an object whose unwrap() misses the vault entry. */
const vault = new WeakMap<object, unknown>()

export function createSecret<T>(value: T): Secret<T> {
  const token = Object.create(null) as Secret<T>
  vault.set(token, value)
  token.unwrap = () => {
    const v = vault.get(token)
    if (v === undefined) {
      throw new Error('Secret unwrap failed: value missing (cloned or GC’d)')
    }
    return v as T
  }
  token.toJSON = () => '[REDACTED:secret]'
  return token
}
```

*Implementation note:* also define `toString`, `Symbol.toPrimitive`, and Node `util.inspect.custom` so **all** introspection paths redact; ensure `JSON.stringify` uses `toJSON`.

### 5.2 `oauth_flow_sessions` (row shape)

```typescript
export interface OauthFlowSessionRow {
  id: string
  /** Base64url opaque value issued to the browser as OAuth `state`. */
  opaque_token: string
  user_id: string
  project_id: string
  connector_id: string
  redirect_uri: string
  pkce_verifier: string
  expires_at: string
  redeemed_at: string | null
  created_at: string
}
```

### 5.3 Connector interfaces

```typescript
export interface Connector {
  readonly connectorId: string
  readonly version: string
  readonly displayName: string
  readonly category: 'saas' | 'database' | 'file' | 'specialized' | 'export_artifact'

  supportedCredentialKinds(): ConnectorCredentialKind[]

  healthCheck(ctx: ConnectorContext): Promise<{ ok: true } | { ok: false; error: ErrorEnvelope }>

  teardown?(ctx: ConnectorContext): Promise<void>
}

export interface SourceConnector extends Connector {
  introspectSchema(ctx: ConnectorContext): Promise<SchemaIntrospectionResult>
  fetchRows(
    ctx: ConnectorContext,
    args: { tableId: string; cursor: ImportCursor | null; limit: number },
  ): Promise<{ rows: Record<string, unknown>[]; nextCursor: ImportCursor | null }>
  readonly supportsIncremental: boolean
}

export interface TargetConnector extends Connector {
  writeRows(
    ctx: ConnectorContext,
    args: {
      tableMappingId: string
      rows: Record<string, unknown>[]
      mode: 'insert' | 'upsert'
    },
  ): Promise<StagingWriteResult>

  dependencyOrder(ctx: ConnectorContext, tableIds: string[]): Promise<string[]>

  readonly upsertByExternalId: boolean

  rollback?(ctx: ConnectorContext, args: { batchId: string }): Promise<{ ok: boolean; error?: ErrorEnvelope }>

  readonly supportsTriggerSuppression: boolean
}

export interface ExportArtifactTarget extends TargetConnector {
  readonly artifactFormat: 'sql' | 'zip' | 'json' | 'python' | 'other'

  generateArtifact(ctx: ConnectorContext, args: GenerateArtifactArgs): Promise<{ blob: Uint8Array; filename: string }>
}

export type ConnectorCredentialKind =
  | 'sql_password'
  | 'oauth2'
  | 'oauth2_jwt_bearer'
  | 'api_key'
  | 'aws_iam'
  | 'none'

export type ConnectorLogger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void

export type ConnectorContext = {
  connection: Connection
  /** In-memory only — never pass across Inngest step boundaries. */
  credentialSecret: Secret<ConnectorCredentialPayload>
  projectId: string
  orgId: string
  log: ConnectorLogger
}

/** Plain shape inside Secret<>; what gets encrypted into connector_credentials. */
export type ConnectorCredentialPayload =
  | { kind: 'sql_password'; username: string; password: string; sslMode?: string }
  | {
      kind: 'oauth2'
      accessToken: string
      refreshToken?: string
      expiresAtEpochSec?: number
      scopes: string[]
    }
  | { kind: 'oauth2_jwt_bearer'; clientId: string; privateKeyPem: string; tokenEndpoint: string; subject?: string }
  | { kind: 'api_key'; headerName: string; value: string }
  | { kind: 'aws_iam'; region: string; roleArn: string; externalId?: string }
  | { kind: 'none' }

export interface Connection {
  id: string
  org_id: string
  project_id: string
  dataset_id: string | null
  connector_id: string
  connector_version: string
  display_name: string
  status: 'pending' | 'active' | 'error' | 'revoked'
  /** Non-secret: api version, sandbox flag, BYO client id (public), etc. */
  config: Record<string, unknown>
  credential_id: string
  last_health_check_at: string | null
  /** Always normalized through normalizeErrorEnvelope() before persist. */
  last_error: ErrorEnvelope | null
  created_by: string
  created_at: string
  updated_at: string
}

export type ConnectorJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ConnectorJob {
  id: string
  connection_id: string
  project_id: string
  kind: 'schema_introspection' | 'source_sync' | 'target_push' | 'artifact_export' | 'connection_test'
  status: ConnectorJobStatus
  progress: { pct: number; message?: string; unitsProcessed?: number; unitsTotal?: number }
  payload: Record<string, unknown>
  /** Summary-level error; per-step detail lives in connector_job_steps. */
  error: ErrorEnvelope | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/** Append-only event row — no UPDATES. */
export interface ConnectorJobStepEvent {
  id: string
  connector_job_id: string
  step_index: number
  seq: number
  event_kind: 'started' | 'completed' | 'failed' | 'retried'
  step_kind: string
  status: string
  started_at: string
  completed_at: string | null
  request_summary: Record<string, unknown> | null
  response_summary: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  error: ErrorEnvelope | null
}

export interface RateLimitPolicy {
  maxRequestsPerSecond: number
  maxConcurrent: number
  coolDownMsOn429: number
  budgetHint?: { window: 'day' | 'hour'; remaining?: number }
}

export interface SchemaIntrospectionResult {
  tables: Array<{
    name: string
    fields: Array<{
      name: string
      dataType: string
      isNullable: boolean
      isPrimaryKey: boolean
      isForeignKey: boolean
      fkReference?: string | null
      isReadOnly?: boolean
    }>
  }>
  warnings: ErrorEnvelope[]
}

export interface StagingWriteResult {
  batchId: string
  appliedRowCount: number
  rejectedRows: Array<{ rowNumber: number; stagedRowId: string; error: ErrorEnvelope }>
  rawProviderResponse?: Record<string, unknown>
}

export type ImportCursor = {
  v: number
  payload: Record<string, unknown>
}

export interface ErrorEnvelope {
  code: string
  message: string
  retryable: boolean
  httpStatus?: number
  provider?: string
  details?: Record<string, unknown>
}

interface GenerateArtifactArgs {
  dialect?: 'postgresql' | 'tsql' | 'mysql'
  format: 'single_file' | 'per_table'
}
```

---

## 6. Architecture and data flow

### 6.1 Adding a connection (Salesforce)

User selects **Salesforce** on the Source/Target card. UI requests an auth URL; server creates **`oauth_flow_sessions`** row (opaque `state`, PKCE verifier, 5-minute TTL) and returns the authorize URL. User consents. **`app/api/auth/connectors/[connectorId]/callback/route.ts`** validates state, enforces **single-use** (`redeemed_at`), applies **IP rate limits**, exchanges code (**15s**, **no retry**). **Edition / Bulk API gate** runs **before** `connections` insert or credential write; on failure redirect **`unsupported_edition`**. On success: encrypt payload into **`connector_credentials`**, insert **`connections`** (`status = active`), run **inline health check**, redirect to **`.../connections/[connectionId]/success`**.

### 6.2 Source schema introspection

Inngest job **`schema_introspection`**: load connection, **unwrap `Secret` only inside step**, call Salesforce describe APIs (**v63.0** URLs), emit **`connector_job_steps` events** at step boundaries, upsert `tables` / `fields` per existing precedence rules.

### 6.3 Source data fetch

**`source_sync`** job pages data into **`data_rows`** (same batching philosophy as `uploadCSV`). Progress on **`connector_jobs`**. Steps append **`connector_job_steps`** events only.

### 6.4 Target live write (Salesforce)

**INSERT-then-upsert-by-Id:** first push uses **create** paths; persisted Ids written to **`staged_data_rows.target_external_id`**. Later pushes use **Id** as key. Each Bulk CSV includes **`_settle_row_id`** matching **`staged_data_rows.id`** for correlation in success/failure CSVs — stripped from mapping UI. **Partial failures** → `quality_issues` rows + **`target_push_status = failed`** + FK link. **Re-push** skips **`succeeded`**. **Job-level failure** resets in-flight rows to **`pending`**. **Source mutation after success** sets row back to **`pending`** while retaining **`target_external_id`** until policy clears it.

### 6.5 Export artifact generation

**`artifact_export`** invokes **`ExportArtifactTarget.generateArtifact`**; v1 may delegate to existing `_outputs-core` / `execution-package` behind the interface.

### 6.6 Re-import / schema diff

Same as prior design: re-introspect, diff, user acknowledges drift.

---

## 7. Salesforce target (worked example)

Decisions **5–10** are normative for this section:

- **OAuth:** Settle Connected App + eight hardening measures; **BYO** reserved for v1.5 (`config`/`credential` ready).
- **Scopes:** **`api` + `refresh_token` + `offline_access`** only.
- **Objects:** Standard + custom; Recommended vs Show all; namespace grouping; Big/External deferred; Custom Settings labeling; Person Accounts documented.
- **Editions:** Enterprise+ floor + dev/partner; **callback block** before persistence; demo sandbox; limits on card.
- **API:** **v63.0** pin + January review + grep guard test + per-connection `config` record.
- **Failures:** `quality_issues`, `staged_data_rows` status columns, `_settle_row_id`, append-only **`connector_job_steps`**, retention, edge cases per §2.9.
- **Ids:** **INSERT then upsert by Salesforce Id** — no customer external-id fields in v1.

**Bulk API 2.0:** primary path for volume; **503/429** — backoff + jitter; switch from REST to Bulk per row-count policy in implementation guide.

---

## 8. Migration and deprecation

### 8.1 `db_connections` → unified model (Option 1)

- **Single atomic deploy** behind **`projects.use_connector_framework`** gate at Project Setup.
- **Backfill:** migrate all `db_connections` rows → `connections` + `connector_credentials` (encrypted).
- **No dual-read:** application code switches under flag; **`db-connector.ts`** reads **only** `connections`.
- **Parity tests** required before deploy — current **`db-connector` test coverage is thin to nonexistent** in `tests/`; add **before** refactor (Section 2).
- **Cleanup migration** (post-rollout): drop `db_connections`, remove legacy types/paths, drop `use_connector_framework` column, **one** commit.

### 8.2 File connectors

Wrap `uploadCSV`, DDL, schema-doc actions behind **`FileSourceConnector`** adapters; incremental deprecation of direct calls only after parity.

### 8.3 SQL exports

Medium scope: **`SqlArtifactAdapter`** delegating to existing generators until merged.

### 8.4 Feature flag

**`use_connector_framework`** on **`projects`**, default **FALSE**, Heritage canary → default **TRUE** → drop.

---

## 9. Edge cases

- OAuth token refresh mid-job — unwrap in step; on **revoked refresh**, fail job with normalized error.
- **Partial Bulk failure** — normal; correlate via **`_settle_row_id`**; populate **`quality_issues`**; preserve successful Ids.
- **Job-level Bulk failure** — mark in-flight **`staged_data_rows`** back to **`pending`**.
- **Schema drift mid-migration** — block push until acknowledged.
- **Large volumes** — Bulk 2.0, chunked Inngest steps.
- **Polymorphic lookups** — explicit mapping UX; no silent inference.
- **Formula / rollup fields** — read-only; exclude from writes.
- **Validation rules / duplicates** — expect row-level failures; severity mapping per §2.9.
- **Concurrent API limits** — cap parallel workers per connection.
- **Disconnected Connected App / sandbox refresh** — re-auth CTA on card.
- **`state_already_redeemed`** — second callback rejected; user must restart OAuth from card.
- **Network failure during token exchange** — **no retry**; user must re-run flow (new code).
- **Leaked OAuth code** — single-use + short TTL + rate limits limit blast radius; **`redeemed_at`** prevents double-spend.
- **Source mutation after successful push** — row **`pending`**, **`target_external_id`** retained per §2.9.

---

## 10. Security posture

- **Encryption:** AES-256-GCM for `connector_credentials` bytes; **`key_version`** for rotation; **`rotated_from`** chain.
- **RLS:** §2.3–2.4; platform admin via **`is_platform_admin`**; credentials **not** broadly readable.
- **Secret<T> + connectorLogger + normalizeErrorEnvelope + tests** — §2.11.
- **No CHECK constraint** secret scanning; **nightly detection Inngest** on audit columns.
- **`oauth_flow_sessions`:** short TTL, single-use, PKCE, IP limits.
- **`connector_job_steps`:** append-only; **INSERT-only** app role; privileged role **only** for retention.
- **Audit events:** connection lifecycle, OAuth refresh, job start/complete/fail — `activity_log` or successor.
- **SOC 2 narrative:** Inngest **Type II** + Settle controls on **redaction, RLS, and retention**.

---

## 11. Test plan

- **Unit:** connector registry, encrypt/decrypt roundtrip, job state machine, rate-limit middleware, **`normalizeErrorEnvelope`**.
- **Integration (Salesforce):** sandbox, env-gated; **OAuth callback** including **state replay** and **edition-block** before persistence.
- **Invariant:** `salesforce-api-version-guard.test.ts`; no Salesforce HTTP outside connector package; no credential reads outside store; **`connector-logger-only.test.ts`**; **`secret-unwrap-audit.test.ts`**; **`error-normalization-coverage.test.ts`**.
- **Heritage:** pinned snapshots for outputs after connector adapters touch generation.
- **`db-connector` parity:** new tests **required** prior to `db_connections` cutover (Section 2).

---

## 12. Open questions

**None.** All items from the 2026-03 investigation draft were **resolved** during founder review on **2026-04-23**. Authoritative answers are the **14 decisions** in **Section 2**.

---

## 13. Supersedes notice

This document **supersedes** the **March 31, 2026** internal design **“Mine — Database Connectors”** (PDF / historical handoff) wherever they conflict.

**Preserved patterns from the legacy doc**

- **Import-into-staging architecture** — sources land in **`data_rows`** / **`staged_data_rows`**; downstream mapping and validation remain agnostic of connector flavor.
- **Read-only source connectors** (conceptually) — no destructive reads without explicit future design.
- **Framework writes to staging; downstream doesn’t care** invariant.
- **Phased rollout with canary projects** — now explicit via **`use_connector_framework`**.

**Replaced / outdated in the legacy doc**

- **Per-connector phase model** (“Phase 4 Salesforce as essentially separate project”) → **unified Connector Framework** with Salesforce as **first SaaS target**.
- **`database_connections`-style schema** → **`connections` + `connector_credentials`** with **full migration** from `db_connections`.
- **Hand-waved OAuth** → **fully specified** callback routes, **`oauth_flow_sessions`**, PKCE, minimal scopes, rotation, **edition gate before persist**.
- **Bare-string credential handling** → **`Secret<T>`**, **four-layer redaction**, **append-only `connector_job_steps`**, **nightly detection scans**.

---

*End of document.*
