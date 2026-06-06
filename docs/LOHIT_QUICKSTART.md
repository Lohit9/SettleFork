# Backend Integration Quickstart

Reference for building the Configure UI and wiring it to the backend: environments, testing, and the contracts to call.

## Environments
- `main` is production. `dev` is the integration branch; Vercel builds a preview for every branch.
- There is currently a single Supabase project. The `dev` preview and production use the same database.
- For testing writes, use a scratch project created in the app rather than a customer or baseline project.

## Shipping and testing
- Changes ship by PR into `dev`. CI runs type-check, lint, tests, and build; merge once green.
- `pnpm test` runs the unit tests. When a change affects an existing test, update it in the same PR.
- `pnpm tsc --noEmit` runs the type-check; the pre-commit hook also runs type-check and lint on changed files.
- To confirm a write persisted, perform it in the app against a scratch project and check the row in the Supabase table editor.
- Production deploys (merge to `main`, plus migration apply) are handled separately.

## Maintenance mode
Each project has a `maintenance_mode` flag. When it is `true`, writes to that project are blocked (`assertMappingWritesEnabled` returns a "writes temporarily disabled" error). If writes fail unexpectedly on a project, check `projects.maintenance_mode`.

## Contracts
Live on `dev`. Full shapes in `docs/FRONTEND_CONTRACTS.md`.

Reads:
- `getMapTransformSpec(projectId)`: one row per target field, with `sourceTable`/`sourceField`, `targetTable`/`targetField`, `transformation`, `explanation`, `confidence`, `needsReview` (confidence < 25%), and `reviewState` (`'reviewed' | 'needs_review' | 'rejected'`). The "Reviewed X/Y" count is the number of rows where `reviewState === 'reviewed'`.
- `getReadyToLoadView(projectId, opts?)`: the Data Preview data, a two-row header (target fields and per-field source mapping) plus transformed rows. Paginated via `opts.offset`; `totalRowCount` is the total.

Writes:
- `updateFieldMappingStatus(tfmId, status)`: sets a field's status to `'approved'` (shown as "reviewed"), `'rejected'`, or `'needs_review'`. Call it with `'approved'` when a field is marked reviewed.
- Reads and writes require project access via `requireProjectPermission`.

Invariants:
- Cells are not directly editable; edits go through the drawer or popover and the value is re-derived (SET-169).
- Review does not block Generate or download (SET-237).
- Confidence is display-only (SET-130).

## Reference
- `docs/FRONTEND_CONTRACTS.md`: full contract shapes.
- `lib/actions/`: server actions (`map-transform-spec.ts`, `ready-to-load.ts`, `mappings*.ts`).
- `CLAUDE.md`: stack and conventions.
- Design: the cloud-design mockup.

Questions in Slack.
