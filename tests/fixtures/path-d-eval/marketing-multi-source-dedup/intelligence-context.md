## Migration Intelligence (Reference Only — Do Not Copy Directly)

The following patterns were learned from previous migrations completed by your team.
Use them as HINTS to improve your suggestions, but ALWAYS validate against the actual
source data and target schema for THIS project.

### Transformation Recipes

★★★ Email canonicalization for cross-source dedup (confirmed in 5 migrations)
Lowercase + trim is the minimum; some teams also strip plus-suffixes ("a+tag@b.com" → "a@b.com") before keying. Recipe: canonicalize at the merge boundary, key the unified row on the canonical form, and store the originally-observed forms in a sidecar for audit. Decision: whether to strip plus-suffixes — depends on whether the customer's downstream marketing tooling treats them as distinct addresses.

★★ Source-priority resolution for conflicting fields (confirmed in 4 migrations)
When the same person appears in multiple sources with different field values (e.g., different lead score, different tags, different last-touch date), apply explicit source priority rather than last-write-wins. Common ordering: SaaS-of-record (e.g., Marketo) > volume source (e.g., Mailchimp) > manual imports. Surface as a decision when no priority is documented.

### Data Quality Patterns

★★★ Opt-in / consent flag merge logic (seen in 6 migrations)
NEVER union opt-ins across sources — a "yes" in one source can't override a "no" in another. Compliance contract: the most-restrictive value wins. If any source carries opt_out=true, target opt_out=true regardless of other sources' values. Flag cases where consent flags conflict across sources as a DQ finding for compliance review.

### Domain Context

★ Tag taxonomy collisions across sources
Marketing tools each have their own tag taxonomy ("Hot Lead" vs "MQL" vs "Sales Ready" describing the same concept). Surface tag-canonicalization decisions explicitly rather than auto-merging — the customer's lifecycle vocabulary is part of their business semantics, not a transformation detail.
