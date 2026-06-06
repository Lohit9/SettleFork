# Backend Quickstart (Lohit)

The fast path to building the Configure UI and wiring it to the backend: environments, how to test safely, the gotcha that broke the Rootstock demo, and the exact contracts to call. This is the "what you need now" cut — the full deployment primer (SET-246) is a follow-up.

---

## 1. Environments — there is no staging (yet)

- `main` = production (`usesettle.ai`). `dev` = the integration branch; Vercel gives every branch its own preview URL.
- **There is one Supabase project.** The `dev` preview and prod **share the same (prod) database** — there is no isolated dev/staging DB today. (A real staging env is tracked in SET-245.)
- **So: never test writes against live customer or baseline projects.** To exercise the app's DB operations safely, create a **scratch project** inside the app and work only there. Treat prod data as production, because it is.

## 2. How you ship + how things get tested

- **You ship to `dev`, not prod.** Branch → PR into `dev` → CI must be green (`tsc`, lint, `vitest`, `next build`) → merge. Vercel rebuilds the dev preview. Prod deploys (merge to `main` + manual migration apply) are handled by Alex/Kaan — you never push to prod directly.
- `pnpm test` — vitest unit tests. **Test as you go:** when a UI change breaks an existing test, fix/extend it in the *same* PR rather than ignoring it. A red test is a real signal, not noise.
- `pnpm tsc --noEmit` — type-check (CI gates on this; the Husky pre-commit hook runs it on changed files). Don't `--no-verify` past the hook.
- `pnpm smoke:approve` — the approve-path health check (read-only by default).
- **To verify a DB write actually landed** (your "are saves happening?" question): perform the action in the app against a **scratch project**, then confirm the row in the Supabase Table editor — or ping me the project + field and I'll run a quick `select`. There's no separate test DB, so verification = act-then-inspect on a throwaway project.

## 3. The maintenance-mode gotcha (this is what broke the Rootstock demo)

- Every project has a `maintenance_mode` flag. When it's `true`, the backend **blocks every write** (approve/edit) on that project — `assertMappingWritesEnabled` throws *"writes temporarily disabled."* The UI just **looks broken**, with no obvious cause.
- **If approve/edit silently fails on a project, check `projects.maintenance_mode` first.** A project frozen as a "baseline" reference will have it on (that's exactly what bit the demo).
- Now guarded by `pnpm smoke:approve` (SET-243); a visible UI banner is coming (SET-244). Until then: writes not working → suspect the flag.

## 4. The FE ↔ backend contracts (what to wire the Configure UI to)

All live on `dev`. Full shapes in `docs/FRONTEND_CONTRACTS.md`; the essentials:

**Reads (render the grid + spec):**
- `getMapTransformSpec(projectId)` → one row per target field: `sourceTable/Field`, `targetTable/Field`, `transformation`, `explanation`, `confidence`, `needsReview` (confidence < 25%), and **`reviewState`** (`'reviewed' | 'needs_review' | 'rejected'`). **`reviewState` is what drives the "Reviewed X/Y" count** Kaan asked for — count `reviewState === 'reviewed'`.
- `getReadyToLoadView(projectId, opts?)` → the Data Preview tab: two-row header (target fields + per-field source mapping) + transformed rows. Paginated via `opts.offset`; `totalRowCount` is the true total.

**Writes (the actions the UI calls):**
- `updateFieldMappingStatus(tfmId, status)` — set a field's status: `'approved'` (surfaced in the UI as **"reviewed"**), `'rejected'`, or `'needs_review'`. This is the canonical review path: when the user clicks "mark reviewed," call this with `'approved'`; the grid's reviewed count then comes from the `reviewState` reads above.
- All reads/writes are gated by `requireProjectPermission` — the user must have access to the project, or the call throws.

**Invariants to respect (from the tickets):**
- Cells are never directly editable — edits route through the drawer/popover and the engine re-derives the value (SET-169).
- Review is a **soft** signal — it never blocks Generate or download (SET-237).
- Confidence is display-only and never gates anything (SET-130).

## Where things live
- `CLAUDE.md` — stack, conventions, the "do not" list.
- `docs/FRONTEND_CONTRACTS.md` — full read/write contract shapes + edge-case checklist.
- `lib/actions/` — the server actions (`map-transform-spec.ts`, `ready-to-load.ts`, `mappings*.ts`).
- Linear — your tickets (SET-159/160/164/165/166/237…). The **design source of truth is the cloud-design mockup**, 1:1.

## When you're stuck
Drop questions in Slack with detail — I'm async and offset by timezone (China). For "is my write landing?", name the **scratch project + the field** and I can verify against the DB directly.
