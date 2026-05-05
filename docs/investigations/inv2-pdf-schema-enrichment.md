# Investigation: PDF schema-doc enrichment + ingested-table-name alignment

**Date:** 2026-05-05
**Branch:** `feat/background-job-ingestion` (commit `90ea9ff` — async-ingestion refactor; not relevant to this investigation but noted for reproducibility)
**Mode:** Read-only. No code changes. No commits.

> Every claim below is cited as `file:line-range` and (where useful) accompanied by a ≤10-line snippet. All spot-checks were re-verified against the working tree per Rule 4. Discrepancies between agent reports and the source were resolved by re-reading the source.

---

## Part 1 — DDL parser

### 1a. Parser location + entry point

**Finding.** The DDL parser lives at [`lib/parsers/ddl-parser.ts`](lib/parsers/ddl-parser.ts). Two top-level exports: `parseDDL(sql)` (deterministic, regex-based, [`ddl-parser.ts:312-389`](lib/parsers/ddl-parser.ts#L312-L389)) and `parseDDLWithAI(projectId, userId, sql)` (Claude-assisted fallback when the deterministic parser returns 0 tables, [`ddl-parser.ts:390-431`](lib/parsers/ddl-parser.ts#L390-L431)).

**Evidence.** [`ddl-parser.ts:312-318`](lib/parsers/ddl-parser.ts#L312-L318):

```ts
/** Main deterministic DDL parser. */
export function parseDDL(sql: string): ParsedTable[] {
  const clean = stripComments(sql)
  const tables: ParsedTable[] = []

  // Regex to find CREATE TABLE statements with the opening paren
  const createTableRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w[\]`".]+\s*\.\s*)?(?:\[|`|")?(\w+)(?:\]|`|")?\s*\(/gi
```

### 1b. Accepted extensions / MIME types

**Finding.** Only the upload action (not the parser itself) gates on file extension: `.sql`, `.ddl`, `.txt`. There is no MIME-type check; the gate is based purely on the trailing extension of `file.name`.

**Evidence.** [`lib/actions/ddl-upload.ts:42-44`](lib/actions/ddl-upload.ts#L42-L44):

```ts
const filename = file.name.toLowerCase();
if (
  !filename.endsWith(".sql") &&
  !filename.endsWith(".ddl") &&
  !filename.endsWith(".txt")
) {
  return { success: false, error: "Accepted file types: .sql, .ddl, .txt" };
}
```

> Note: this is a _separate_ upload action from `uploadSchemaDocument` — see Part 2.

### 1c. TypeScript output shape

**Finding.** `ParsedTable` carries `name` + `fields[]`. Each `ParsedField` carries name, dataType, nullability, PK/FK booleans, FK reference string, default-value string, and an optional `CheckConstraint` discriminated union (in_list / regex / range / custom). No table- or column-level descriptions/comments.

**Evidence.** [`ddl-parser.ts:14-34`](lib/parsers/ddl-parser.ts#L14-L34):

```ts
export type CheckConstraint =
  | { type: "in_list"; allowedValues: string[]; raw: string }
  | { type: "regex"; pattern: string; raw: string }
  | { type: "range"; min?: number; max?: number; raw: string }
  | { type: "custom"; raw: string };

export interface ParsedField {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  fkReference: string | null;
  defaultValue: string | null;
  checkConstraint: CheckConstraint | null;
}

export interface ParsedTable {
  name: string;
  fields: ParsedField[];
}
```

### 1d. What the parser extracts

| Metadata                             | Extracted?            | Citation                                                                                                                                                                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Table names                          | Yes                   | [`ddl-parser.ts:323`](lib/parsers/ddl-parser.ts#L323) (regex capture group)                                                                                              |
| Column names                         | Yes                   | [`ddl-parser.ts:189-192`](lib/parsers/ddl-parser.ts#L189-L192)                                                                                                           |
| Column data types                    | Yes                   | [`ddl-parser.ts:85-96`](lib/parsers/ddl-parser.ts#L85-L96) (`parseDataType`)                                                                                             |
| PK (single + composite)              | Yes                   | inline at [`ddl-parser.ts:201`](lib/parsers/ddl-parser.ts#L201); composite via `applyTableConstraints` at [`ddl-parser.ts:258-268`](lib/parsers/ddl-parser.ts#L258-L268) |
| FK (with `table.column` reference)   | Yes                   | inline [`ddl-parser.ts:207-211`](lib/parsers/ddl-parser.ts#L207-L211); table-level [`ddl-parser.ts:272-283`](lib/parsers/ddl-parser.ts#L272-L283)                        |
| NOT NULL                             | Yes                   | [`ddl-parser.ts:200`](lib/parsers/ddl-parser.ts#L200)                                                                                                                    |
| DEFAULT values                       | Yes                   | [`ddl-parser.ts:215-218`](lib/parsers/ddl-parser.ts#L215-L218) (raw expression preserved)                                                                                |
| CHECK — IN list                      | Yes                   | [`ddl-parser.ts:106-114`](lib/parsers/ddl-parser.ts#L106-L114)                                                                                                           |
| CHECK — regex (`~`/`~*`)             | Yes (PostgreSQL only) | [`ddl-parser.ts:117-120`](lib/parsers/ddl-parser.ts#L117-L120)                                                                                                           |
| CHECK — range (BETWEEN, comparators) | Yes                   | [`ddl-parser.ts:123-145`](lib/parsers/ddl-parser.ts#L123-L145)                                                                                                           |
| CHECK — custom fallback              | Yes (`raw` only)      | [`ddl-parser.ts:148-149`](lib/parsers/ddl-parser.ts#L148-L149)                                                                                                           |
| Column comments / `COMMENT ON`       | **No**                | comments are stripped at [`ddl-parser.ts:39-43`](lib/parsers/ddl-parser.ts#L39-L43) before parsing; no extractor anywhere                                                |
| Table comments                       | **No**                | no extractor anywhere                                                                                                                                                    |

### 1e. SQL dialect handling

**Finding.** The parser is dialect-agnostic at the syntactic level — it recognises identifier quoting in three styles (square brackets for SQL Server, backticks for MySQL, double quotes standard / Postgres) and silently strips schema prefixes. It does **not** detect or branch on dialect. If a CREATE TABLE statement matches the regex shape, it parses; if not, it is silently skipped. The AI-fallback prompt mentions PostgreSQL, MySQL, Oracle, SQL Server, SAP HANA, DB2 ([`ddl-parser.ts:381`](lib/parsers/ddl-parser.ts#L381)) but that's a hint to Claude, not a detection step.

### 1f. Upload → parse → DB write call chain

| Step                                           | File:Line                                                                                                          | Action                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1. Upload entry                                | [`lib/actions/ddl-upload.ts:17-105`](lib/actions/ddl-upload.ts#L17-L105)                                           | `parseDDLFile(formData)` — extension gate, file → text                                             |
| 2. Deterministic parse                         | [`ddl-upload.ts:69`](lib/actions/ddl-upload.ts#L69) → [`ddl-parser.ts:312`](lib/parsers/ddl-parser.ts#L312)        | `parseDDL(text)`                                                                                   |
| 3. AI fallback (if 0 tables)                   | [`ddl-upload.ts:73-95`](lib/actions/ddl-upload.ts#L73-L95) → [`ddl-parser.ts:390`](lib/parsers/ddl-parser.ts#L390) | `parseDDLWithAI` via `callLLM`                                                                     |
| 4. User reviews + confirms                     | [`ddl-upload.ts:112-417`](lib/actions/ddl-upload.ts#L112-L417)                                                     | `confirmDDLSchema`                                                                                 |
| 5. Insert into `tables`                        | [`ddl-upload.ts:166-176`](lib/actions/ddl-upload.ts#L166-L176)                                                     | columns: `dataset_id, name, row_count=0, friendly_name, csv_storage_path`                          |
| 6. Insert into `fields` (with `schema_source`) | [`ddl-upload.ts:204-207`](lib/actions/ddl-upload.ts#L204-L207)                                                     | **`schema_source: 'ddl_parsed'`** stamped at [`ddl-upload.ts:201`](lib/actions/ddl-upload.ts#L201) |
| 7. Auto-seed validation rules from CHECK       | [`ddl-upload.ts:225-355`](lib/actions/ddl-upload.ts#L225-L355)                                                     | `allowed_values, regex, range, min_value, max_value`                                               |
| 8. Cross-table FK inference                    | [`ddl-upload.ts:361-379`](lib/actions/ddl-upload.ts#L361-L379)                                                     | `inferCrossTableFKs`                                                                               |
| 9. Persist original DDL                        | [`ddl-upload.ts:381-411`](lib/actions/ddl-upload.ts#L381-L411)                                                     | `schema_documents` row + Storage                                                                   |

Spot-check confirmed at [`ddl-upload.ts:200-203`](lib/actions/ddl-upload.ts#L200-L203):

```ts
default_value: f.defaultValue ?? null,
schema_source: 'ddl_parsed' as const,
```

### 1g. Unknowns

- **Comment extraction.** Even though comments are stripped before parsing, the AI-fallback path (`parseDDLWithAI`) sees the original SQL and _could_ in principle return descriptions — its tool schema is in `lib/ai/tool-schemas.ts` (not read in this investigation). Cannot confirm/deny from `ddl-parser.ts` alone.
- **`inferBasicType`** mapping (imported at line 191) lives elsewhere; not read.

---

## Part 2 — Schema document upload flow

### 2a. `uploadSchemaDocument` server action

**Finding.** Defined in [`lib/actions/schema-documents.ts:16-255`](lib/actions/schema-documents.ts#L16-L255). Auth + project-editor permission check + 20 MB size cap up front; a sibling action `uploadBusinessContextDoc` ([`schema-documents.ts:311-474`](lib/actions/schema-documents.ts#L311-L474)) handles project-scoped business-context docs with the same MIME palette.

**Evidence.** [`schema-documents.ts:16-37`](lib/actions/schema-documents.ts#L16-L37):

```ts
export async function uploadSchemaDocument(formData: FormData): Promise<UploadSchemaDocResult> {
  // ...
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }
```

### 2b. Accepted MIME types / extensions

**Finding.** Server-side validation is extension-only (no MIME check). The allow-list spans 13 extensions: `.pdf, .ddl, .sql, .txt, .doc, .docx, .xlsx, .xls, .xlsb, .csv, .png, .jpg, .jpeg`. The client UI advertises a narrower subset — note the asymmetry below.

**Evidence.** [`lib/upload/validate.ts:45-59`](lib/upload/validate.ts#L45-L59):

```ts
const allowedExtensions = [
  ".pdf",
  ".ddl",
  ".sql",
  ".txt",
  ".doc",
  ".docx",
  ".xlsx",
  ".xls",
  ".xlsb",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
];
const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
if (!ext || !allowedExtensions.includes(ext)) {
  return {
    success: false,
    reason: `File type not allowed. Accepted: ${allowedExtensions.join(", ")}`,
  };
}
```

UI accept attribute (narrower): `'.pdf,.ddl,.sql,.txt,.doc,.docx,.png,.jpg,.jpeg'` — `ControlPlaneContent.tsx:130`. Server accepts more than UI advertises.

### 2c. Storage path pattern

**Finding.** Bucket `'project-files'`, path `${userId}/${projectId}/schemas/${sanitizedFilename}` (upsert).

**Evidence.** [`schema-documents.ts:39-44`](lib/actions/schema-documents.ts#L39-L44):

```ts
const storagePath = `${user.id}/${projectId}/schemas/${sanitizedFilename}`;
const { error: storageError } = await supabase.storage
  .from("project-files")
  .upload(storagePath, file, { upsert: true });
```

### 2d. File-type branching post-upload

**Finding (load-bearing — answers user's question #1 directly).** After Storage upload, `uploadSchemaDocument` extracts text in-process based on extension, then routes the result through one of two pipelines:

1. **`.sql` / `.ddl` / `.txt`** → `mergeConstraintsFromDDL(... 'ddl_parsed')` ([`schema-documents.ts:105-136`](lib/actions/schema-documents.ts#L105-L136)). Stamped `'ddl_parsed'`.
2. **`.pdf` / `.xlsx` / `.xls` / `.xlsb` / `.csv` / `.docx` / `.doc` / `.png` / `.jpg` / `.jpeg`** → `convertDocToDDL` (Claude translates extracted text into PostgreSQL CREATE TABLE statements) → `mergeConstraintsFromDDL(... 'doc_enriched')` ([`schema-documents.ts:137-188`](lib/actions/schema-documents.ts#L137-L188)). Stamped `'doc_enriched'`.

After both branches, [`enrichAllTablesInDataset(datasetId)`](lib/actions/schema-documents.ts#L229-L233) runs as a fire-and-forget AI enrichment pass against the same docs.

**Evidence.** [`schema-documents.ts:137-176`](lib/actions/schema-documents.ts#L137-L176):

```ts
} else if (
  extractedText &&
  ['.pdf', '.xlsx', '.xls', '.xlsb', '.csv', '.docx', '.doc', '.png', '.jpg', '.jpeg'].includes(ext)
) {
  // AI-assisted DDL conversion for non-DDL formats. Claude reads the
  // extracted text and emits PostgreSQL CREATE TABLE statements...
  const { convertDocToDDL } = await import('@/lib/ai/ddl-conversion')
  const convertedDDL = await convertDocToDDL(projectId, user.id, extractedText)
  if (convertedDDL) {
    // ... mergeConstraintsFromDDL(..., 'doc_enriched')
```

### 2e. PDF text extraction

**Finding.** `unpdf@^1.4.0` (pure-JS, Vercel-serverless-safe — [`package.json:54`](package.json#L54)). Called inline during the upload action; result is persisted on `schema_documents.extracted_text` ([`schema-documents.ts:214`](lib/actions/schema-documents.ts#L214)). Same extractor reused by `uploadBusinessContextDoc` ([`schema-documents.ts:354-356`](lib/actions/schema-documents.ts#L354-L356)).

**Evidence.** [`schema-documents.ts:55-63`](lib/actions/schema-documents.ts#L55-L63):

```ts
if (ext === ".pdf") {
  const { extractText } = await import("unpdf");
  const buffer = Buffer.from(await file.arrayBuffer());
  const { text } = await extractText(new Uint8Array(buffer));
  extractedText =
    (Array.isArray(text) ? text.join("\n") : text)?.trim() || null;
  if (!extractedText) {
    console.warn(
      "[uploadSchemaDocument] No text extracted from PDF (may be scanned/image-only):",
      sanitizedFilename,
    );
  }
}
```

### 2f. Vision / image extraction

**Finding.** **No vision-API code path exists.** PNG/JPG/JPEG files are accepted by the upload validator and reach `convertDocToDDL` with `extractedText = null`, which the converter degrades to a no-op. Inline comments at [`schema-documents.ts:90-91`](lib/actions/schema-documents.ts#L90-L91) and [`schema-documents.ts:418`](lib/actions/schema-documents.ts#L418) explicitly defer OCR / vision support. The `callLLM` wrapper accepts only text (`userMessage: string`) — no `MediaBlockParam` / `ImageBlockParam` callsites anywhere in `lib/ai/`.

### 2g. Unknowns

- **Scanned PDFs** are silently skipped (warning logged at upload time, no enrichment fires). Acceptable as documented behaviour; not visible to the end-user as a UI surface today.
- The `convertDocToDDL` Claude prompt was not deeply read — its text → SQL fidelity is not characterised in this investigation.

---

## Part 3 — AI enrichment pass

### 3a. Entry point + log markers

**Finding.** `enrichSchemaFromDocs(datasetId, tableId)` and its dataset-level wrapper `enrichAllTablesInDataset` live in [`lib/actions/schema-enrichment.ts`](lib/actions/schema-enrichment.ts) (518 LOC). Per-table corrections logged with `[enrichSchemaFromDocs]` and `[Enrichment Conflict]`; aggregate caller logs `[schema-documents] Enrichment: …`.

**Evidence.** [`schema-enrichment.ts:85-89`](lib/actions/schema-enrichment.ts#L85-L89):

```ts
export async function enrichSchemaFromDocs(
  datasetId: string,
  tableId: string,
): Promise<EnrichSchemaResult>;
```

### 3b. Triggers

Four call sites:

| Trigger                                                          | File:Line                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Schema-doc upload (PDF/DDL/etc.)                                 | [`schema-documents.ts:229-233`](lib/actions/schema-documents.ts#L229-L233)                                     |
| Business-context doc upload                                      | [`schema-documents.ts:437-440`](lib/actions/schema-documents.ts#L437-L440)                                     |
| CSV ingestion (cron worker, fire-and-forget after table created) | [`app/api/cron/process-ingestion-job/route.ts:421-424`](app/api/cron/process-ingestion-job/route.ts#L421-L424) |
| Manual UI button "Enrich from documentation"                     | `app/app/projects/[projectId]/data-overview/SchemaOverview.tsx:481`                                            |

### 3c. Input shape

**Finding.** The function takes only `(datasetId, tableId)` — it does **not** see raw doc bytes. It pulls pre-extracted text from `schema_documents.extracted_text` (populated at upload time) and pulls inferred fields from the `fields` table. PDF parsing has already happened upstream.

**Evidence.** [`schema-enrichment.ts:165-177`](lib/actions/schema-enrichment.ts#L165-L177):

```ts
const [schemaDocsResult, contextDocsResult] = await Promise.all([
  supabaseAdmin
    .from("schema_documents")
    .select("filename, extracted_text")
    .eq("dataset_id", datasetId)
    .eq("doc_type", "schema")
    .not("extracted_text", "is", null),
  // ... business-context query (project-scoped, doc_type='business_context')
]);
```

### 3d. Output: `fields` and `validation_rules` writes

**Finding.** When the AI proposes a correction:

- If `canOverride(currentSchemaSource, 'doc_enriched')` is true → UPDATE the field's structural columns and stamp `schema_source = 'doc_enriched'`.
- If overriding is not allowed (existing row is `'manual'` or `'ddl_parsed'`) → route the conflict into `validation_rules` as a **warning-severity** rule instead of overwriting (preserves higher-authority source while still surfacing the discrepancy).

**Evidence — overwrite path** [`schema-enrichment.ts:276`](lib/actions/schema-enrichment.ts#L276) and [`schema-enrichment.ts:319-324`](lib/actions/schema-enrichment.ts#L319-L324):

```ts
const updates: Record<string, unknown> = { schema_source: "doc_enriched" };
// ... merges is_nullable, is_primary_key, is_foreign_key, fk_reference,
// inferred_type, data_type when corrections exist
const { data: updatedRows, error: updateErr } = await supabaseAdmin
  .from("fields")
  .update(updates)
  .eq("id", field.id)
  .in("schema_source", overridableSources) // race guard
  .select("id");
```

**Evidence — conflict-as-warning path** [`schema-enrichment.ts:407-517`](lib/actions/schema-enrichment.ts#L407-L517) inserts into `validation_rules` with `severity='warning'`.

### 3e. PDF handling today

**Finding (key reframing — see Gap analysis).** PDFs are _already_ fully wired into the enrichment path. The chain is:

1. Upload → `unpdf` extracts text inline ([`schema-documents.ts:55-63`](lib/actions/schema-documents.ts#L55-L63))
2. Text → `convertDocToDDL` translates it into PostgreSQL CREATE TABLE statements via Claude ([`schema-documents.ts:152-153`](lib/actions/schema-documents.ts#L152-L153))
3. Synthetic DDL → `mergeConstraintsFromDDL(..., 'doc_enriched')` writes structural metadata to `fields` with `schema_source = 'doc_enriched'` ([`schema-documents.ts:168-176`](lib/actions/schema-documents.ts#L168-L176))
4. `enrichAllTablesInDataset` runs on the same `extracted_text` to layer additional AI corrections ([`schema-documents.ts:229-233`](lib/actions/schema-documents.ts#L229-L233))

The only PDFs that _don't_ enrich are scanned/image-only PDFs (no text extracted → silently skipped, warning logged).

### 3f. Prompt structure — reference vs authoritative

**Finding.** Within `enrichSchemaFromDocs`, the Claude prompt explicitly labels the **documentation as AUTHORITATIVE** for structural metadata ([`schema-enrichment.ts:44-81`](lib/actions/schema-enrichment.ts#L44-L81)). Manual-edit priority is enforced _outside the prompt_ by the `canOverride` priority cascade — the AI is never told "this row was manually edited"; instead, a manual-stamped row is structurally protected from being overwritten.

> However, the _mapping/transform/validation_ prompt builders take the opposite stance — see Part 5: there, docs are labelled **reference** and the structured schema is the source of truth. The two prompts serve different jobs and that distinction is intentional.

### 3g. Model + retry/fallback

**Finding.** Model selection is centralised in `resolveDefaultModel()` ([`lib/ai/llm-client.ts:246-248`](lib/ai/llm-client.ts#L246-L248)) — `claude-opus-4-7` when `AI_PHASE_2_ENABLED='1'`, else `claude-sonnet-4-6`. No retry on parse failure: if `JSON.parse` (or the tool-use parse) fails, the function returns `error: 'Failed to parse AI response'` immediately ([`schema-enrichment.ts:239-247`](lib/actions/schema-enrichment.ts#L239-L247)).

### 3h. Unknowns

- Whether `convertDocToDDL` (the PDF→SQL translator) is itself well-tested for fidelity. Not in scope for this investigation.
- Whether `enrichSchemaFromDocs` runs against the multi-agent pipeline when `AI_PHASE_3_MULTI_AGENT_ENABLED='1'` — feature appears off in `vercel.json` and that flag wasn't searched.

---

## Part 4 — DDL Merge / 3-layer matcher

### 4a. Entry point + log markers

**Finding.** `mergeConstraintsFromDDL` in [`lib/actions/schema-merge.ts:115-470`](lib/actions/schema-merge.ts#L115-L470) is the orchestrator. Logs use `[Schema Merge]` for general operations and `[DDL Merge]` for the layer-by-layer table matcher.

**Evidence.** [`schema-merge.ts:115-122`](lib/actions/schema-merge.ts#L115-L122):

```ts
export async function mergeConstraintsFromDDL(
  datasetId: string,
  projectId: string,
  userId: string,
  ddlText: string,
  datasetRole: "source" | "target",
  schemaSourceOverride: SchemaSource = "ddl_parsed",
): Promise<MergeConstraintsResult>;
```

### 4b. Layer 1 — normalised name match

**Finding.** Lowercase + strip underscores, hyphens, whitespace. Exact-equality match after normalisation; no Levenshtein, no prefix/suffix stripping, no singular/plural handling.

**Evidence.** [`lib/utils/name-normalize.ts:17-19`](lib/utils/name-normalize.ts#L17-L19):

```ts
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]+/g, "");
}
```

So `BRANCH_INFO`, `Branch Info`, `branch-info` all collapse to `branchinfo`. **Customers vs customer (singular) would NOT match** — that's a gap implicit in the implementation.

[`schema-merge.ts:597-605`](lib/actions/schema-merge.ts#L597-L605):

```ts
const pKey = normalizeName(p.name)
for (const e of existing) {
  if (usedExistingId.has(e.id)) continue
  if (normalizeName(e.name) !== pKey) continue
  // ... claim e for p; log:
  console.log(`[DDL Merge] Layer 1 match: ${p.name} → "${e.name}" (normalized name)`)
```

### 4c. Layer 2 — field fingerprint

**Finding.** Set of normalised field names per table. A DDL table matches an existing table iff `matched ≥ 3` AND `matched/total ≥ 0.6`. Greedy by descending overlap; each existing table claimed at most once.

**Evidence.** [`schema-merge.ts:572-573`](lib/actions/schema-merge.ts#L572-L573):

```ts
const LAYER2_MIN_OVERLAP = 0.6; // 60%
const LAYER2_MIN_MATCHED_FIELDS = 3;
```

Comparison body — [`schema-merge.ts:624-650`](lib/actions/schema-merge.ts#L624-L650):

```ts
const existingFieldKeys = remainingExisting.map(
  (e) => new Set(e.fields.map((f) => normalizeName(f.name))),
);
// ... for each remaining DDL table:
let matched = 0;
for (const k of pKeys) if (eKeys.has(k)) matched++;
const overlap = matched / Math.max(pKeys.size, 1);
if (matched >= LAYER2_MIN_MATCHED_FIELDS && overlap >= LAYER2_MIN_OVERLAP) {
  // candidate
}
```

### 4d. Layer 3 — AI fallback

**Finding.** Claude (Sonnet/Opus per `AI_PHASE_2_ENABLED`) is invoked only on the residual after Layers 1+2. Prompt asks for high-precision matches with explicit "omit if not confident" instruction. Phase-2 path uses a strict `emit_table_matches` tool; Phase-2-off path uses JSON text parsing with code-fence stripping. Errors are non-fatal — unmatched tables are logged and skipped.

**Evidence — prompt body** [`schema-merge.ts:750-781`](lib/actions/schema-merge.ts#L750-L781) (10-line excerpt):

```ts
const SYSTEM_PROMPT = `You are matching DDL-declared tables against
existing database tables whose names may differ due to display-name
conventions.
...
Identify which DDL table corresponds to which existing table. Use
field-name overlap and semantic name equivalence. Prefer precision
over recall: if you are not confident, omit the match.
...`;
```

Tool schema: [`lib/ai/tool-schemas.ts:655-684`](lib/ai/tool-schemas.ts#L655-L684) (`emit_table_matches` returns `{ matches: [{ ddl_table_name, existing_table_id }] }`).

Fallback — [`schema-merge.ts:718-721`](lib/actions/schema-merge.ts#L718-L721):

```ts
} catch (err) {
  console.warn(`[DDL Merge] Layer 3 AI matching failed (non-fatal): ${msg}`)
}
```

### 4e. Field-level merge after table match

**Finding.** Once two tables match, fields are matched by the **same** `normalizeName` rule. Three outcomes per parsed field: insert (target dataset only), priority-skip (`canOverride` returns false), or update structural columns + stamp `schema_source`.

**Evidence.** [`schema-merge.ts:205-308`](lib/actions/schema-merge.ts#L205-L308) — pivotal write at [`schema-merge.ts:303-308`](lib/actions/schema-merge.ts#L303-L308):

```ts
const { data: updatedRows, error: updErr } = await supabaseAdmin
  .from("fields")
  .update(updates)
  .eq("id", match.id)
  .in("schema_source", overridableSources) // optimistic-concurrency guard
  .select("id");
```

### 4f. Does merge mutate ingested table names?

**Finding (load-bearing — answers user's question #2 directly).** **No.** The merge writes only to the `fields` table. There is no `UPDATE tables SET name = …` anywhere in `schema-merge.ts`. After a successful Layer 1/2/3 match between an ingested `CUSTOMERS` and a DDL `customers_v2`, the ingested name is preserved verbatim and only the field metadata is updated.

**Evidence — spot-check confirmed.** Only one `from('tables')` callsite in the entire file, and it's a SELECT for the matcher — [`schema-merge.ts:171-174`](lib/actions/schema-merge.ts#L171-L174):

```ts
const { data: tablesRaw, error: tablesErr } = await supabaseAdmin
  .from("tables")
  .select("id, name, fields(id, name, schema_source, ordinal_position)")
  .eq("dataset_id", datasetId);
```

When new fields are inserted for a matched table they reuse the existing `table_id` ([`schema-merge.ts:240`](lib/actions/schema-merge.ts#L240)) — confirming "metadata enrichment, not renaming."

### 4g. Orphan handling

| Case                                   | Behaviour                                                    | Evidence                                                           |
| -------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Ingested table with no DDL counterpart | Untouched, no flag, no warning.                              | (absence of code)                                                  |
| DDL table with no ingested counterpart | Logged once, **silently skipped — no INSERT into `tables`**. | [`schema-merge.ts:726-731`](lib/actions/schema-merge.ts#L726-L731) |

[`schema-merge.ts:726-731`](lib/actions/schema-merge.ts#L726-L731):

```ts
for (let i = 0; i < parsed.length; i++) {
  if (!usedDdlIdx.has(i)) {
    console.log(
      `[DDL Merge] No match for DDL table "${parsed[i].name}" — skipping`,
    );
  }
}
```

This is _different_ from the dedicated `confirmDDLSchema` upload path (Part 1.f step 5), which DOES insert new tables — but that's the user-confirmed flow, not the auto-merge that fires from PDF/PDF-derived doc uploads.

### 4h. Unknowns

- Whether the AI matcher's precision is empirically validated. The prompt asks for precision, but no offline scoring run is visible.
- No cycle-detection on circular FK declarations; not visible whether downstream code handles cycles.

---

## Part 5 — `schema_source` enum + priority semantics

### 5a. Enum definition

**Finding.** Five values, ordered low → high authority in `SCHEMA_SOURCE_PRIORITY`: `inferred → cross_table_inferred → doc_enriched → ddl_parsed → manual`. The **TypeScript comment in `lib/types/database.ts:47-48` is stale and contradicts the canonical priority array** — see 5e.

**Evidence — canonical priority** [`lib/utils/schema-priority.ts:31-37`](lib/utils/schema-priority.ts#L31-L37):

```ts
export const SCHEMA_SOURCE_PRIORITY = [
  "inferred",
  "cross_table_inferred",
  "doc_enriched",
  "ddl_parsed",
  "manual",
] as const;
```

**Evidence — DB constraint** [`supabase/migrations/063_schema_source_expansion.sql:17-30`](supabase/migrations/063_schema_source_expansion.sql#L17-L30) (extends the original allowed set from migration 020 to add `'ddl_parsed'` and `'cross_table_inferred'`).

`canOverride(existing, new) = newIdx ≥ existingIdx` (with unknown `existing` strings treated as overridable for legacy-row safety) — [`schema-priority.ts:54-62`](lib/utils/schema-priority.ts#L54-L62).

### 5b. Writers

| File:Line                                                                                    | Trigger                            | Value                                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| [`migrations/020_add_schema_source.sql:4`](supabase/migrations/020_add_schema_source.sql#L4) | DB column DEFAULT                  | `'inferred'`                                                                      |
| `app/api/cron/process-ingestion-job/route.ts:204-206`                                        | CSV ingestion (cron worker)        | implicit `'inferred'` via DB DEFAULT                                              |
| [`lib/actions/ddl-upload.ts:201`](lib/actions/ddl-upload.ts#L201)                            | DDL script upload (user-confirmed) | `'ddl_parsed'`                                                                    |
| `lib/actions/db-connector.ts:787`                                                            | Live DB introspection              | `'ddl_parsed'`                                                                    |
| [`lib/actions/schema-merge.ts:121, 251, 296`](lib/actions/schema-merge.ts#L121)              | Merge from DDL/connector           | `schemaSourceOverride` (default `'ddl_parsed'`; PDF path passes `'doc_enriched'`) |
| `lib/quality/fk-inference.ts:309-311`                                                        | Cross-table FK inference           | `'cross_table_inferred'` (only if currently `'inferred'`)                         |
| [`lib/actions/schema-enrichment.ts:276`](lib/actions/schema-enrichment.ts#L276)              | AI doc-enrichment pass             | `'doc_enriched'`                                                                  |
| [`lib/actions/fields.ts:96-101`](lib/actions/fields.ts#L96-L101)                             | Manual edit (Schema Overview UI)   | `'manual'` (unconditional in-place overwrite)                                     |

### 5c. Readers in AI prompt assembly

**Finding (significant).** Across mapping, transform, validation-rule generation, and migration-intelligence prompt builders, **the `schema_source` value is not surfaced to the model**. The single AI-side reader is `lib/ai/context-builder.ts`, and even there it is stored on `FieldContext` but explicitly _not_ emitted into the prompt string.

**Negative-grep evidence.** `grep -n "schema_source\|schemaSource"` against `lib/actions/mappings.ts`, `lib/actions/transformations.ts`, `lib/actions/validation-rules.ts`, `lib/actions/migration-intelligence.ts`, `lib/actions/quality-fixes.ts`, `lib/actions/ai-quality-detection.ts`, `lib/ai/mapping-engine.ts`, `lib/ai/multi-agent-prompts.ts`, `lib/ai/multi-agent-orchestrator.ts`, `lib/ai/single-agent-mapping.ts`, `lib/ai/agent-loop.ts`, `lib/ai/agent-tools.ts`, `lib/ai/document-context.ts` — **0 hits** in all of them.

**Evidence — read-but-not-emit.** [`lib/ai/context-builder.ts:23-25`](lib/ai/context-builder.ts#L23-L25):

```
Provenance label. Not emitted in the prompt today, but carried on the
context so future heuristics (confidence weighting, skip rules) can
use it.
```

`formatSchemaForPrompt` ([`context-builder.ts:518-578`](lib/ai/context-builder.ts#L518-L578)) and `formatFieldForPrompt` ([`context-builder.ts:717-746`](lib/ai/context-builder.ts#L717-L746)) build a flag list (`PK`, `FK→…`, `nullable`, `semantic:…`, `CHECK …`) and never reference `field.schema_source`.

**Implicit priority surfaced to AI.** The structured `<source_schema>` / `<target_schema>` block is asserted as the source of truth, and uploaded docs are explicitly labelled "reference" — [`context-builder.ts:524-525`](lib/ai/context-builder.ts#L524-L525):

```
Current ${label} schema — source of truth for data types, constraints,
nullability, and relationships. If documentation below describes
different structural definitions, this schema takes precedence.
```

And [`context-builder.ts:667-673`](lib/ai/context-builder.ts#L667-L673):

```
These are reference schema documents (DDL scripts, ERDs, data dictionaries)
...
IMPORTANT: If these documents describe a different data type, constraint,
nullability, or relationship than the structured <source_schema> or
<target_schema> sections, ALWAYS follow the structured schema. The
structured schema reflects the user's latest configuration and is the
source of truth for all structural definitions.
```

So manual-edit primacy is enforced via two layers:

1. **At write time**, by `canOverride` blocking lower-authority writes against a `'manual'` row.
2. **At prompt time**, by the structured-schema-vs-reference-doc framing — the AI never sees competing values, just one canonical row.

### 5d. Manual-edit contract

**Finding.** `updateField` overwrites the row in place and stamps `schema_source = 'manual'`. No new row, no audit row. Prior `'ddl_parsed'` provenance is **lost** at the row level (the original DDL is still in `schema_documents` if the user wants to re-derive it).

**Evidence.** [`lib/actions/fields.ts:96-101`](lib/actions/fields.ts#L96-L101):

```ts
const { data: updated, error } = await supabase
  .from("fields")
  .update({ ...updates, schema_source: "manual" })
  .eq("id", fieldId)
  .select()
  .single();
```

### 5e. Unknowns / latent issues

- **Stale comment in `lib/types/database.ts:47-48`** declares precedence as `'manual' > 'doc_enriched' > 'cross_table_inferred' > 'ddl_parsed' > 'inferred'`, but the canonical `SCHEMA_SOURCE_PRIORITY` array places `'ddl_parsed'` ABOVE `'doc_enriched'`. The runtime uses the array, so the comment is wrong — likely written before migration 063 (which added `'ddl_parsed'`) and never updated. **Per CLAUDE.md §14, flagged for human resolution; not fixing in this read-only investigation.**
- The CSV ingestion path _never_ explicitly stamps `'inferred'` — it relies on the DB column DEFAULT. If a future migration changes the default, CSV-ingested rows would silently change provenance label.
- Whether `schema_source` _should_ enter prompts (for confidence weighting) is anticipated by [`context-builder.ts:23-25`](lib/ai/context-builder.ts#L23-L25) but not roadmapped in code.

---

## Part 6 — Ingestion table naming

### 6a. Where the user enters/confirms a table name

**Finding.** `IngestionCard.tsx` shows either an existing-table picker or a free-text "new table" input. The name passes through `getCsvUploadSlot` (presence check only, no length/character/uniqueness validation) and then `queueIngestionJob` (same presence check). The cron worker then uses the name verbatim when creating the `tables` row.

**Evidence — UI** `app/app/projects/[projectId]/project/IngestionCard.tsx:1610-1635`:

```tsx
{showNewTableInput && (
  <div className="flex gap-2">
    <Input
      placeholder="Table name (e.g. Account)"
      value={newTableName}
      onChange={(e) => setNewTableName(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && handleSaveNewTable()}
      autoFocus
    />
```

**Evidence — server validation** [`lib/actions/csv.ts`](lib/actions/csv.ts) `getCsvUploadSlot` and [`lib/actions/ingestion-jobs.ts:52`](lib/actions/ingestion-jobs.ts#L52) both reject only on missing fields — no name-shape validation, no uniqueness check within the dataset.

**Evidence — cron worker uses the name verbatim** `app/api/cron/process-ingestion-job/route.ts:238-252` inserts `name: job.table_name` into `tables`.

### 6b. Post-ingestion editability

**Finding.** **No.** No rename UI exists for tables created via CSV ingestion. The only "rename" UX is the _pre-confirmation_ DDL review dialog (`DDLSchemaReview.tsx:29-32`) which lets the user edit parsed-table names _before_ `confirmDDLSchema` writes them.

**Evidence.** [`lib/actions/tables.ts`](lib/actions/tables.ts) is 16 lines and exports only a SELECT helper (`getDatasetTables`) — there is no `renameTable` / `updateTable` action. Grep for `renameTable | update.*table.*name | rename_table` across `lib/actions/tables.ts components/ app/` returns zero hits.

### 6c. Reconciliation with `schema_documents` today

**Finding.** **None.** The CSV ingestion flow makes zero queries to `schema_documents` between user-name entry and table creation. The only DDL/schema-doc interaction in the ingestion path is the _post-table-creation_ fire-and-forget `enrichSchemaFromDocs` call (`route.ts:421-424`), which corrects field metadata but never touches the table name.

**Negative-grep evidence:**

```
grep -n "schema_documents\|parsedTable.*name\|suggestTable" \
  lib/actions/csv.ts lib/actions/ingestion-jobs.ts \
  app/api/cron/process-ingestion-job/route.ts
# zero hits
```

### 6d. Where reconciliation could most naturally hook in (forward-looking)

Two candidate hooks, ordered by minimum-friction:

1. **`IngestionCard.tsx:1610-1618` — pre-submission name input.** Once a dataset is selected (line 1589), fetch the parsed-DDL table names from `schema_documents` for that dataset and surface them as autocomplete suggestions in the same `<Input>` (or a typeable combobox). Friction: UI-only; no schema changes; user can still type a free-text name.
2. **Cron worker, pre-table-creation at `app/api/cron/process-ingestion-job/route.ts:190-252`.** After `job.table_name` is in scope and before the `tables` INSERT (line ~238), run a light name-similarity check against parsed-DDL table names (Levenshtein or `normalizeName` reuse from Layer 1 of the matcher). On a near-miss, emit a structured suggestion into the `ingestion_jobs.metadata` JSON column and surface a non-blocking "Did you mean: customers_v2?" toast in the UI poll. Friction: zero AI calls; deterministic; doesn't override the user.

A third option — auto-rename to the DDL name — is **not recommended** because it would introduce identity-rotation risk under active use (the reconciled name might already collide with another ingested table; it would invalidate any in-flight mapping the user has been editing).

### 6e. Unknowns

- Whether users _want_ this reconciliation at upload time vs. as a post-hoc nudge in Schema Overview. No telemetry visible.
- Whether `schema_documents` are typically uploaded before or after CSV ingestion. The flows are independent today.

---

## Gap analysis

### Goal 1 — "PDF schema docs should enrich the Schema Overview tab"

**What exists today.** The architecture is **already in place**, contrary to the user's premise:

- PDFs are accepted by `uploadSchemaDocument`'s allow-list ([`schema-documents.ts`](lib/actions/schema-documents.ts) via [`lib/upload/validate.ts:45-59`](lib/upload/validate.ts#L45-L59)).
- Inline `unpdf` extraction populates `schema_documents.extracted_text` ([`schema-documents.ts:55-63`](lib/actions/schema-documents.ts#L55-L63)).
- `convertDocToDDL` translates extracted text → PostgreSQL CREATE TABLE statements ([`schema-documents.ts:152-153`](lib/actions/schema-documents.ts#L152-L153)).
- That synthetic DDL flows through the same `mergeConstraintsFromDDL` pipeline as a real `.sql` upload, but with `schemaSourceOverride: 'doc_enriched'` ([`schema-documents.ts:175`](lib/actions/schema-documents.ts#L175)).
- A subsequent `enrichAllTablesInDataset` AI pass layers additional corrections on the same docs ([`schema-documents.ts:229-233`](lib/actions/schema-documents.ts#L229-L233)).

In the runtime priority cascade (`SCHEMA_SOURCE_PRIORITY`), this places PDFs at `doc_enriched` — **strictly above `inferred`/`cross_table_inferred`, strictly below `ddl_parsed`/`manual`**. Manual edits and explicit `.sql` uploads still win, which is the correct trust ordering.

**What's actually missing.** Three real gaps remain:

1. **Scanned/image-only PDFs are silently skipped.** `unpdf` returns no text → enrichment short-circuits at `if (extractedText)` ([`schema-documents.ts:227`](lib/actions/schema-documents.ts#L227); [`schema-enrichment.ts:165-177`](lib/actions/schema-enrichment.ts#L165-L177)). No vision/OCR path exists ([`schema-documents.ts:90-91`](lib/actions/schema-documents.ts#L90-L91)). The user has no UI signal that the PDF was effectively a no-op.
2. **No UX breadcrumb that PDF enrichment ran.** Today the user uploads a PDF, gets a "Document uploaded" toast, and the field metadata silently changes via the `[schema-documents] Enrichment` server log. There is no per-field provenance pill in Schema Overview that says "from `<filename>.pdf`."
3. **The TypeScript priority comment is stale ([`lib/types/database.ts:47-48`](lib/types/database.ts#L47-L48))** — declares `'doc_enriched' > 'ddl_parsed'`, but runtime uses the opposite. Not user-facing, but a future contributor reading the doc will be misled.

**Smallest viable change to close the gap.**

| Gap                                         | Smallest viable change                                                                                                                                                                                                                        | Rough size                                                                               | Worktree                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| Scanned-PDF silent skip                     | Detect "extracted text was empty for image-bearing PDF" at upload time and surface a single user-facing toast/banner: "This PDF appears to be scanned. Schema enrichment requires text-extractable PDFs (try Adobe OCR before re-uploading)." | ~30 LOC across `schema-documents.ts` + UI toast; no new dep                              | A worktree (UX)           |
| No provenance breadcrumb in Schema Overview | Add a small "from `<filename>`" tag next to fields whose `schema_source = 'doc_enriched'`. Requires joining `schema_documents.filename` onto the field row at SELECT time.                                                                    | ~80–150 LOC: one DB-side helper to resolve provenance + UI badge in `SchemaOverview.tsx` | A worktree (UI)           |
| Stale `database.ts:47-48` comment           | Single-line edit aligning the comment with the canonical array; flag for human verification per CLAUDE.md §14.                                                                                                                                | ~3 LOC                                                                                   | A worktree (housekeeping) |
| Vision/OCR for scanned PDFs (longer-term)   | Add Anthropic vision-API support to `callLLM` (currently text-only — [`lib/ai/llm-client.ts`](lib/ai/llm-client.ts)) and route image-bearing PDFs through a vision call before `convertDocToDDL`.                                             | Multi-week; new wrapper API + cost tracking + schema enrichment in `convertDocToDDL`     | A worktree (significant)  |

None of these touch ingestion, the cron worker, or B-worktree scope. **All gap-closure work is A-worktree only.**

---

### Goal 2 — "Ingested table names should align with DDL/PDF schema-doc table names"

**What exists today.**

- The 3-layer DDL Merge matcher (`schema-merge.ts`) reconciles ingested tables to DDL/synthetic-DDL tables on the **fields side** but never on the **table-name side** ([`schema-merge.ts:171-174`](lib/actions/schema-merge.ts#L171-L174); the only `from('tables')` is a SELECT, not an UPDATE).
- DDL tables that find no ingested counterpart are silently dropped from the merge (logged at [`schema-merge.ts:726-731`](lib/actions/schema-merge.ts#L726-L731), no `tables` INSERT).
- The user enters the table name once during CSV upload (`IngestionCard.tsx:1610`); after ingestion, no rename UI exists ([`lib/actions/tables.ts`](lib/actions/tables.ts) has no rename action; zero hits in `components/` and `app/`).
- Layer 1 normalisation (`lowercase + strip [_\-\s]`) is forgiving for case + separator differences but does **not** handle singular/plural (`Customer` vs `Customers`), prefixes (`tbl_`, `dbo_`), or domain-aware aliases — those fall to Layer 2's field-fingerprint match (60% overlap, ≥3 matched fields).

**What's missing.**

1. **No suggest-on-upload.** When the user types a table name, no UI surfaces "you have 3 tables in your DDL doc — pick one" ([`IngestionCard.tsx:1610`](app/app/projects/[projectId]/project/IngestionCard.tsx#L1610)).
2. **No after-the-fact "Did you mean?" prompt.** After CSV ingestion completes and DDL Merge runs, an unmatched-on-Layer-1-but-near-miss table never surfaces to the user. Today the only signal is a server log `[DDL Merge] No match for DDL table "FOO" — skipping`.
3. **No rename UX on existing ingested tables.** Even if the user later realises their table name was wrong, the only recourse is delete + re-upload.
4. **No singular/plural awareness in `normalizeName`** — would help reduce false negatives in Layer 1 without weakening precision much.

**Smallest viable change to close the gap.**

| Gap                                | Smallest viable change                                                                                                                                                                                                                                                                                                                                                                                             | Rough size                                                            | Worktree                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| No suggest-on-upload               | When the user opens "create new table," fetch parsed-DDL table names for the dataset (`schema_documents` → `parseDDL` cache or persisted `parsed_tables` column on `schema_documents`) and render them as autocomplete suggestions.                                                                                                                                                                                | ~120–200 LOC across one server-action helper + `IngestionCard.tsx` UI | A worktree                                                     |
| No "Did you mean?" after merge     | In `mergeConstraintsFromDDL`'s orphan-loop ([`schema-merge.ts:726-731`](lib/actions/schema-merge.ts#L726-L731)), compute a Levenshtein/normalised-name distance to each unmatched ingested table; if ≤ 2 character edits or normalisation match modulo singular/plural, write a row to a new `schema_suggestions` (or reuse `validation_rules` with a new `rule_type`) so the UI can surface a non-blocking nudge. | ~150–300 LOC + a small migration                                      | A worktree (UI) and B worktree (server logic) — overlap modest |
| No rename UX                       | Add `renameTable(tableId, newName)` in `lib/actions/tables.ts` with editor-RBAC guard; add inline-edit in Schema Overview. The dataset uniqueness constraint on `tables.name` already prevents collisions if it exists (verify in migration 002 — not read in this investigation).                                                                                                                                 | ~80 LOC + UI work                                                     | A worktree                                                     |
| Singular/plural in `normalizeName` | Extend [`name-normalize.ts:17-19`](lib/utils/name-normalize.ts#L17-L19) to strip a trailing `s` _only when matching_, not when displaying. Touches the matcher only, not the persisted name.                                                                                                                                                                                                                       | ~10 LOC + targeted test                                               | B worktree (matcher logic)                                     |

> Cross-worktree note: the cleanest split is **A = ingestion UI + Schema Overview rename UX + suggest dropdown**; **B = matcher logic (`schema-merge.ts`, `name-normalize.ts`) + the orphan-suggestion writer**. The pieces compose without conflict because B writes the suggestion rows; A reads them.

---

## Spot-checks performed (Rule 4 verification)

1. ✅ `schema-priority.ts` array order — read in full ([`lib/utils/schema-priority.ts:31-37`](lib/utils/schema-priority.ts#L31-L37)).
2. ✅ `database.ts:47-48` comment is actually stale — confirmed by direct read.
3. ✅ PDF inline extraction at [`schema-documents.ts:55-63`](lib/actions/schema-documents.ts#L55-L63) and PDF→DDL→merge wiring at [`schema-documents.ts:137-188`](lib/actions/schema-documents.ts#L137-L188) — confirmed by direct read.
4. ✅ `ddl-upload.ts:201` stamps `'ddl_parsed'` — confirmed by direct read.
5. ✅ `fields.ts:96-101` manual-edit overwrite — confirmed by direct read.
6. ✅ `schema-merge.ts` no-rename — confirmed: only one `from('tables')` callsite, and it's a SELECT ([`schema-merge.ts:171-174`](lib/actions/schema-merge.ts#L171-L174)).
7. ✅ `tables.ts` is 16 lines, no rename action — confirmed via `wc -l` and direct read.

## Open questions for the human

1. **Is the `database.ts:47-48` comment the _intended_ priority** (and the array is wrong) or vice-versa? The runtime trusts the array; if the comment is correct, migration 063's reordering needs revisiting. Per CLAUDE.md §14, flagging this for resolution before any code change in this area.
2. **Does the user expect PDF schema docs to drive `'ddl_parsed'`** (same authority as a real `.sql` upload) **or `'doc_enriched'`** (current behaviour, lower than `.sql`)? The current architecture is conservative — AI translation introduces error, so DDL wins — but this is a product decision, not a code one.
3. **Should the matcher's orphan handling escalate from a server log to a user-visible nudge?** Today an unmatched DDL table with 5 close-but-non-matching column names is silently dropped; a one-line product decision changes the UX significantly.

---

_Report end. Source content is ~590 lines (within the 600-line single-file budget); post-formatter on-disk count is higher because Prettier expands markdown tables and snippets across more lines._
