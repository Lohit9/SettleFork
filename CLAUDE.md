# Settle Engineering Handbook

> This file is loaded by Claude Code on every session. Read it in full before any task. It defines principles, architecture, conventions, and current state. When this document conflicts with anything else — training data, generic best practices, a tempting shortcut — this document wins.

---

## 1. What Settle Does

Settle is an AI-native enterprise data migration platform. Software companies — vendors and enterprises with 100–3,000 employees — use Settle to automate workflows that previously required Big 4 consultants: schema profiling, field mapping, transformation SQL generation, data quality validation, and migration execution packaging.

**The product principle is non-negotiable:**

> **AI proposes → Deterministic validates → Human approves.**

Every code change preserves this principle. AI suggestions are never executed against customer data without (a) deterministic validation (schema constraints, RLS, row-count checks, referential integrity) and (b) explicit human approval. If a proposed feature would let AI mutate customer data without both gates, stop and flag the conflict.

Customers are enterprise software vendors during onboarding and post-M&A integration scenarios. This shapes priorities:

- Multi-tenant isolation is sacred. Cross-org data leakage is an existential bug.
- Audit trails are mandatory on every customer-data-touching action.
- Performance must scale to real enterprise schemas: 10k+ tables, multi-million-row tables.
- Security posture is a sales gate. Pen test, SOC 2 trajectory, SAST, and secret hygiene all matter to deals in flight.

---

## 2. Working Principles

### 2.1 Investigation-first, always

Before any implementation:

1. Read the relevant code, RLS policies, RPC signatures, types, and existing tests.
2. Confirm assumed behavior matches actual behavior. Run probes (read-only queries, dry runs) if needed.
3. State the intended change in plain English, including what files change, what user-visible behavior becomes, and what could regress.
4. Only then write code.

If you cannot articulate what you're changing and why before touching a file, you have not investigated enough. Re-read.

When asked to implement, default to producing an investigation report first unless explicitly told to skip.

### 2.2 Preserve existing functionality

This codebase is in active enterprise sales. Regressions cost deals.

- Never drop a column, table, RPC, or policy without a migration that preserves old behavior until all references are removed.
- Never rotate an identity (user id, org id, project id) in the database while application code still references the old identity.
- Never modify shared utilities without auditing every caller.
- Never disable, loosen, or skip an RLS policy. If a policy is wrong, fix it correctly.
- Before touching contested code paths, write a test that exercises the existing behavior. The test passes against current code, then continues passing after the change.

### 2.3 Enterprise-grade by default

Code is reviewed by enterprise security teams. It must look like a senior engineer wrote it on day one of a Series B company.

- Strict TypeScript. No `any` without an inline `// reason:` comment.
- Errors are typed and handled at the boundary that can act on them. No swallowed catches.
- All inputs validated at the trust boundary (HTTP handler, RPC entry, file upload). Use Zod.
- All secrets via environment variables; never hardcoded, never logged. Husky pre-commit scans for secret prefixes.
- All customer-data-touching paths emit structured logs: `{ org_id, project_id, actor_id, action, outcome, duration_ms, request_id }`.
- All async operations have timeouts and cancellation. No unbounded `await fetch(...)`.
- All long-running jobs are idempotent and resumable.
- Naming is precise. `migrateData` is wrong; `stageRowsForValidation` is right.

### 2.4 Pause before irreversible operations

Stop and ask the human before:

- Applying any SQL migration to production.
- Force-pushing any branch.
- Rotating credentials, secrets, or service-role keys.
- Deleting any production data, including rows that look like tests.
- Merging to `main` or propagating to `dev` outside the documented three-step deploy.

The confirmation phrase to wait for is: **"last-minute changes?"** Confirm none, then proceed.

### 2.5 One concern per branch, per PR, per prompt

Do not bundle. Each feature branch addresses one workstream. Each PR has one reviewable concern. Each Claude Code prompt addresses one investigation or one implementation, never both at once.

---

## 3. Tech Stack

| Layer        | Choice                              | Notes                                                            |
| ------------ | ----------------------------------- | ---------------------------------------------------------------- |
| Frontend     | Next.js 14 App Router               | TypeScript strict, Server Components by default                  |
| UI           | Tailwind CSS + shadcn/ui            | Design benchmarks: Linear, Notion, Supabase Dashboard, Figma     |
| Backend      | Supabase (Postgres + Auth + Storage)| RLS enforced on every customer-data-touching table               |
| Auth         | Supabase Auth (GoTrue)              | SAML 2.0 SSO (Okta, Entra, Google Workspace), JIT provisioning   |
| Hosting      | Vercel Pro                          | Preview deploys per PR, prod on `main`                           |
| Email        | Resend                              | Transactional only                                               |
| Anti-spam    | Cloudflare Turnstile                | All public forms                                                 |
| Testing      | Vitest                              | Unit + integration                                               |
| CI           | GitHub Actions + Husky pre-commit   | Secret scanning, type-check, lint, tests                         |
| AI           | Anthropic API (Claude Sonnet)       | All AI features go through a single typed wrapper                |

Repository: `~/dev/settle-platform`
Worktrees: `~/dev/settle-<feature-slug>`
Git author identity: `kaandincer1@gmail.com` (must match across every worktree)

---

## 4. Architecture Overview

### 4.1 Migration pipeline (the product spine)

The product is a five-stage pipeline. Every code path either advances a project through these stages or supports them.

1. **Schema Overview** — connect or upload source; profile tables, columns, types, distributions. **Manual edits in this tab are the source of truth for structural definitions.** Uploaded documents (data dictionaries, ERDs) are supplementary business context only.
2. **Mapping** — AI proposes source→target field mappings with confidence scores; user reviews, edits, approves. Unmapped fields surface explicitly.
3. **Transform** — AI generates SQL transformations per mapping; user reviews and edits; transformations are versioned.
4. **Validate** — runs against **staged data only**, never source. Surfaces row-level failures with **root-cause tracing** back to the offending mapping or transformation.
5. **Migration Center** — packages the approved migration as an executable artifact (SQL bundle, runbook, rollback plan).

A change that touches the boundary between two stages must explicitly preserve the contract at that boundary. See `docs/PRODUCT_PRINCIPLES.md` for stage contracts.

### 4.2 Multi-tenant model

- Top-level tenant: `organization` (org).
- Inside an org: `projects` (one migration engagement = one project).
- Inside a project: `members` with project-level roles.
- Cross-cutting: `platform_admin` (Settle-internal staff).

Every customer-data-touching table has an `org_id` column. Every RLS policy filters on `org_id` derived from the authenticated session. Cross-org reads are impossible by construction, not by convention.

### 4.3 RBAC model

Two scopes:

- **Org-level:** owner, admin, member. Controls billing, SSO config, member management.
- **Project-level:** owner, editor, viewer. Controls migration project access. Recently shipped; behavioral verification pending against live Postgres/GoTrue.

Platform admin is orthogonal to org/project roles and is granted via a separate `platform_admins` table. Platform admin access is audit-logged on every action.

### 4.4 Database conventions

- Every write goes through a `SECURITY DEFINER` RPC that re-asserts RLS context. No direct table writes from the client.
- RPCs are named `verb_noun` (e.g., `create_project`, `assign_project_role`).
- RLS policies live next to table definitions in migration files, not scattered.
- Foreign keys are enforced; orphans are bugs.
- Soft deletes use `deleted_at TIMESTAMPTZ`. Hard deletes are reserved for compliance requests.
- All timestamps are `TIMESTAMPTZ`, stored UTC, rendered in the user's locale at the edge.

**Pending consolidation:** `createProject` plus its fanout (default project member, default settings, audit row) should consolidate into a single transactional `SECURITY DEFINER` RPC. Until that lands, treat the fanout as a known atomicity gap and never partially apply it.

### 4.5 AI integration boundary

All Anthropic API calls go through a single typed wrapper. The wrapper:

- Selects the model (Claude Sonnet by default).
- Sets request timeouts and retry policy.
- Strips PII from prompts where the AI's job does not require it.
- Logs prompt size, response size, latency, model, and cost estimate.
- Parses AI output against a Zod schema before any downstream consumer sees it.

If an AI feature wants to call a tool that mutates customer data, route the proposed action through the validation + approval flow described in §1. No exceptions.

### 4.6 Database connectors (in design)

PostgreSQL first. Constraints:

- Credentials encrypted at rest with AES-256-GCM; key in env (later: CMEK).
- All connector queries run in **read-only** transactions.
- Hard cap: **500K rows** per source pull; larger pulls require staged sampling.
- Connection strings are never logged in full; redact host and credentials in audit trails.

Connector design details belong in `docs/ARCHITECTURE.md`.

---

## 5. Authentication & SSO

Current state:

- Email/password and magic link via Supabase Auth.
- SAML 2.0 SSO branches in flight: `feat/sso-login-redesign`, `feat/sso-okta-setup`. Launch IdPs: Okta, Microsoft Entra, Google Workspace.
- JIT (just-in-time) user provisioning on first SSO login. Org membership is bound to the SAML domain claim.
- SCIM provisioning is on the roadmap; not yet implemented.

Locked architectural decisions (do not relitigate without explicit ask):

- SAML 2.0 only at launch. No OIDC.
- JIT provisioning, not pre-provisioning.
- SSO config is per-org, not per-user.

Auth form Turnstile integration (signup, login, forgot-password) is **deferred until SSO branches merge**. Do not preempt this.

---

## 6. Security

### 6.1 Standing controls

- All public forms gated by Cloudflare Turnstile (PR #1, merged).
- Husky pre-commit hook scans for secret prefixes (AWS, Anthropic, Supabase service role, Stripe). Commits with matches are rejected.
- RLS on every customer-data-touching table.
- `org_invites` RLS hardening completed.
- Platform admin path refactored; audit logging in place.

### 6.2 In flight

- Pen test: vendor selection between Cobalt, Include Security, and Doyensec. Target kickoff May 12, report early June. Budget anchor $8K–$15K.
- SAST: AppSecAI POC arranged.
- SOC 2: not yet started formally; one-page security posture document available for pilot conversations.

### 6.3 Roadmap

- SCIM provisioning.
- CMEK (customer-managed encryption keys).
- Formal SOC 2 Type 1 program.

### 6.4 Non-negotiables

- Never log secrets, full connection strings, customer PII, or auth tokens.
- Never weaken RLS, even temporarily, even "just for debugging."
- Never commit a `.env` or any credential file. The pre-commit hook is a safety net, not a permission slip.
- Never paste customer data into AI prompts during development.

---

## 7. Git Workflow

### 7.1 Branching

- `main` is production. Vercel deploys `main` to `usesettle.ai`.
- `dev` is the integration branch. Vercel deploys `dev` to a preview URL.
- Feature branches: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`. One concern per branch.

### 7.2 Worktrees

Worktrees live at `~/dev/settle-<slug>` and let multiple branches be checked out simultaneously without stashing.

When creating a new worktree:

```bash
git worktree add ~/dev/settle-<slug> -b feat/<slug>
cd ~/dev/settle-<slug>
git branch --unset-upstream
git config user.email "kaandincer1@gmail.com"
```

`--unset-upstream` is required to prevent accidental pushes to the wrong remote branch on the first commit.

The Cursor or VS Code window and the terminal **must point to the same worktree**. Working in mismatched windows is the top source of "why isn't my change showing up" bugs.

### 7.3 Commits

Conventional Commits style. Examples:

- `feat(sso): add Okta SAML connector`
- `fix(rls): tighten org_invites select policy`
- `chore(deps): bump @supabase/ssr to 0.4.1`
- `refactor(projects): consolidate createProject fanout into RPC`

The repo uses **real merge commits, not squash**. Preserve commit history on merges.

### 7.4 Three-step deploy

1. Push the feature branch to origin.
2. From a worktree on `main`, merge the feature branch (real merge commit) and push.
3. Propagate `main` → `dev` from a worktree on `dev`.

Do not skip step 3. `dev` lagging `main` corrupts preview environments and confuses debugging.

### 7.5 Pull requests

- One concern per PR. If the description contains "and also...", split.
- Include: what changed, why, what was tested, what could regress, screenshots for UI changes, schema diff for migrations.
- Migrations require an explicit "applied to prod at \<timestamp\>" comment on merge.

---

## 8. CI / CD

### 8.1 Pre-commit (Husky)

Runs locally on every commit:

- Secret prefix scanner.
- Lint-staged: ESLint + Prettier on changed files.
- Type-check on changed `.ts`/`.tsx`.

A failing hook blocks the commit. Do not pass `--no-verify` to bypass without explicit human approval.

### 8.2 GitHub Actions

On every PR:

- Type-check (`tsc --noEmit`)
- Lint (`eslint`)
- Tests (`vitest run`)
- Build (`next build`)

On merge to `main`:

- Vercel production deploy.
- Migration manifest checked against prod schema (manual apply gate — never auto-apply).

### 8.3 Environments

| Env        | Branch | URL          | Supabase project           |
| ---------- | ------ | ------------ | -------------------------- |
| Production | `main` | usesettle.ai | settle-prod                |
| Dev        | `dev`  | dev preview  | settle-dev                 |
| Local      | any    | localhost    | local Supabase or scratch  |

For RBAC behavioral verification and other risky changes, prefer a **temporary scratch Supabase project** over `dev`.

---

## 9. Code Quality Standards

### 9.1 TypeScript

- `strict: true`. No `any` without an inline `// reason: <why>` comment.
- Prefer `unknown` over `any` when the type is genuinely unknown at the boundary.
- Discriminated unions for state machines (project status, validation status, migration status).
- Branded types for ids: `type OrgId = string & { __brand: 'OrgId' }`.

### 9.2 Errors

- Throw typed errors at the boundary that creates them.
- Catch at the boundary that can act on them (HTTP handler returns 4xx/5xx; UI shows toast).
- Never `catch { }`. Never log-and-swallow without an explicit `// fire-and-forget: <why>`.
- User-facing error messages never leak stack traces or DB schema details.

### 9.3 Validation

- **Zod is the codebase's input-validation framework**, pinned to `^3` in `package.json` (Zod 4.x has breaking chaining-API differences; migration to 4.x will be a deliberate single-PR upgrade once enough call sites exist to benchmark the differences).
- Every external input (HTTP body, query param, file upload, AI response, server-action input) parsed through Zod.
- Reject early. Do not coerce silently.
- **Canonical adopter:** [`lib/actions/projects.ts`](lib/actions/projects.ts) — module-level constants for tunable bounds, module-level `z.object` schemas, `.safeParse` inside the action body returning the first issue via the standard `{ success: false, error }` shape. Future server actions that need validation should follow this pattern. Migration of existing actions is incremental, not bundled.

### 9.4 Tests

Vitest. Targets:

- Pure functions: 100%.
- RPCs and RLS policies: integration tests against a scratch Supabase.
- Critical paths (auth, RBAC, migration packaging): regression tests written before changes.

Tests are first-class. Do not mark `.skip` to make CI pass without explicit approval.

### 9.5 Logging

Structured, JSON, server-side. Standard fields:

```
level         'info' | 'warn' | 'error'
org_id        UUID or null
project_id    UUID or null
actor_id      UUID (user) or 'system'
action        verb_noun (e.g., 'create_project')
outcome       'ok' | 'denied' | 'error'
duration_ms   number
request_id    UUID
```

No `console.log` in committed code. Use the logger.

### 9.6 Performance

- Server Components by default. Client Components only when interactivity demands it.
- Streaming for any response that can exceed 500ms.
- Pagination on every list endpoint. Hard cap: 500 rows per page.
- Database indexes on every foreign key and on every `org_id` column.

### 9.7 Accessibility

- Keyboard navigable.
- ARIA roles, keyboard navigation, and focus management come for free from the Radix-backed primitives in `components/ui/*` (Select via [`select.tsx`](components/ui/select.tsx), DropdownMenu via [`dropdown-menu.tsx`](components/ui/dropdown-menu.tsx), Popover via [`popover.tsx`](components/ui/popover.tsx)). When adding a new menu / popover / dialog primitive, prefer wrapping a Radix primitive in `components/ui/` rather than re-implementing focus traps and key handling. Hand-add ARIA only where no Radix wrapper exists yet.
- Color contrast WCAG AA. Brand teal `#1D9E75` on white passes; verify combinations before shipping.
- **Single-field settings forms** use [`useEditableField`](lib/hooks/useEditableField.ts) — the canonical state-machine hook for the lightweight no-toast / no-Zod-on-client / no-react-hook-form pattern. Two UX modes: Edit-toggle (default) and `alwaysEditing: true`. Adopted by ProfileCard and OrganizationSettings. NOT for multi-field forms with sequential save (e.g. InfoTab) — extend with a `useEditableFieldGroup` hook when a 4th multi-field caller appears.

---

## 10. Development Workflow

### 10.1 Prompt structure

Every Claude Code session targets one of:

- **Investigation** — read-only, produces a report. No code changes.
- **Implementation** — produces code, behind an investigation. Must reference the investigation it implements.
- **Review** — reads a PR or diff, produces critique.

Do not bundle. An investigation prompt that ends with "...and then implement it" is two prompts.

### 10.2 Investigation report format

```
## Question
<what we're trying to learn>

## Files read
<list>

## Findings
<plain English>

## Risks if changed
<list>

## Proposed implementation plan
<numbered steps, file-by-file>

## Open questions
<for the human>
```

### 10.3 Implementation report format

```
## Investigation referenced
<link or filename>

## Files changed
<list with one-line summary each>

## Tests added or updated
<list>

## What I did not change
<and why — usually because it was out of scope>

## Verification
<commands run, screenshots, or queries>

## Follow-ups
<known gaps or deferred work>
```

### 10.4 Checkpoints

Use Claude Code's checkpoint feature liberally. Before any multi-file change, the conversation has an implicit checkpoint. After a successful change, take a manual checkpoint before the next refactor.

---

## 11. Current State (as of May 2026)

### 11.1 Done

- Cloudflare Turnstile on three public forms (PR #1, merged).
- `org_invites` RLS hardening.
- Platform admin path refactor.
- SSO architecture decisions locked.
- RBAC project-level role implementation (behavioral verification pending).

### 11.2 In flight

- `feat/sso-login-redesign` and `feat/sso-okta-setup` branches.
- `fix/migration-pages-history` (ships first).
- Pen test vendor selection.
- AppSecAI SAST POC.

### 11.3 Next

- Auth form Turnstile (after SSO merge).
- RBAC behavioral verification on a scratch Supabase project.
- `createProject` + fanout RPC consolidation.
- PostgreSQL connector (first database connector).
- SCIM provisioning.
- CMEK.

---

## 12. Critical "Do Not" List

Each of these has bitten this codebase or a similar one. Internalize.

- Do not weaken RLS, even for "just one query."
- Do not rotate identifiers in DB while app code holds the old ones.
- Do not skip the three-step deploy.
- Do not pass `--no-verify` to the pre-commit hook.
- Do not paste customer data into AI prompts during development.
- Do not commit `.env` or anything matching a secret prefix.
- Do not bundle two concerns into one branch, PR, or prompt.
- Do not `any`-cast away a type error. Fix the type.
- Do not schedule destructive migrations without the "last-minute changes?" pause.
- Do not change Schema Overview semantics — manual edits there are the source of truth.
- Do not run validation against source data; staged data only.

---

## 13. Reference Documents

When more depth is needed, see:

- `docs/ARCHITECTURE.md` — full data model, RPC catalog, pipeline contracts, connector design
- `docs/SECURITY.md` — full security posture, threat model, controls catalog
- `docs/GIT_WORKFLOW.md` — worktree recipes, deploy runbook, recovery procedures
- `docs/PRODUCT_PRINCIPLES.md` — AI integration boundary, validation rules, stage contracts

This file (`CLAUDE.md`) stays focused on what every session needs. Push depth into the docs above.

---

## 14. When This Document Is Wrong

This document is updated by humans. If during a session you discover that something here contradicts the actual code, **flag it before proceeding**. Do not silently work around documented conventions. The convention may be wrong, the code may be wrong, or the document may be stale — the human decides which.