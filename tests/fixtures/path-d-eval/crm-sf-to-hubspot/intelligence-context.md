## Migration Intelligence (Reference Only — Do Not Copy Directly)

The following patterns were learned from previous migrations completed by your team.
Use them as HINTS to improve your suggestions, but ALWAYS validate against the actual
source data and target schema for THIS project.

### Transformation Recipes

★★★ Status / lifecycle enum normalization (confirmed in 4 migrations)
Source CRM systems frequently emit mixed-case enum variants for the same logical state ("New", "NEW", "new", "Open"). Recipe: lowercase + canonicalize via the documented allowed-value list, and surface a decision for any value that doesn't map cleanly. Do NOT silently coerce to a fallback bucket — unmapped enum values are signal, not noise.

★★ Person-name field shape conventions (confirmed in 3 migrations)
Many target CRMs (HubSpot family, monday.com) use a single full-name field while sources keep first/last separate. Combine via concat_space when both source fields are populated; surface a decision when either side is null (some downstream targets require non-null full names, others tolerate partials).

### Data Quality Patterns

★★ Email canonicalization for dedup (seen in 5 migrations)
Lowercase + trim before any uniqueness check. Source CRMs commonly carry "Person@Example.com" and "person@example.com" as distinct rows; target dedup keys must collapse them. Flag rows where canonicalization changes the value as a DQ finding (~5-15% rate is normal for legacy CRM data).

### Domain Context

★ Cross-system owner / user-id translation
When source and target systems have distinct user identity stores (Salesforce User → HubSpot Owner), 1:1 ID translation is rarely possible. Common pattern: resolve via email match if both systems carry the user's email, otherwise surface as a decision for stakeholder mapping. NOT a transformation recipe — it requires human input.
