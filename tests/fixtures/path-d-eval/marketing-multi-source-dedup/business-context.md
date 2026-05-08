# Marketing data consolidation — Mailchimp + Marketo + manual CSVs → unified contact warehouse

## Overview

A 40-employee mid-market SaaS company is consolidating three disjoint
marketing data sources into a single `unified_contacts` warehouse table that
will feed downstream analytics + a future single-source-of-truth contact
system. Every contact will appear at most once in `unified_contacts`,
identified by lowercased email.

## Sources

1. **Mailchimp** (`mailchimp_subscribers`, ~12,000 rows) — newsletter/drip
   marketing audience. Has tags but no lead score.
2. **Marketo** (`marketo_leads`, ~8,500 rows) — sales-side lead database with
   lead-score-driven scoring.
3. **Manual CSV uploads** (`manual_csv_imports`, ~2,300 rows) — campaign
   imports from trade shows, webinars, partner referrals.

The same person commonly appears in 2-3 of these sources with overlapping
data. Roughly 30-40% of all source rows have a duplicate elsewhere.

## Migration goals

- **Dedupe by lowercased email.** Email is the canonical identity. Mailchimp
  is internally unique, but Marketo and CSV both have within-source duplicates
  (case differences, repeated CSV uploads).
- **Pick best value per field.** When two sources provide a value for the
  same field (e.g., `first_name`):
  - Marketo wins if present (highest data quality)
  - Mailchimp second
  - CSV last
- **Preserve `first_seen_at`** as MIN of (Mailchimp's `subscribed_at`,
  Marketo's `createdAt`, CSV's `import_date`).
- **Concatenate all sources contributing to a contact** into `all_sources`
  (e.g., `"mailchimp,marketo"`). Set `primary_source` to the highest-priority
  source the contact appears in.
- **Carry Mailchimp tags through** to `tag_list`; concat unique tags across
  all Mailchimp rows for that email.
- **`subscription_status`**: `'unsubscribed'` if Mailchimp's
  `unsubscribed_at` is non-null; otherwise `'subscribed'` if any source has
  the email; never `'unknown'` in this migration (the default is for
  manually-added rows that don't have signup metadata, which doesn't apply
  here).

## Known data-quality concerns

- Email case differs across sources (`carol@megacorp.net` in Mailchimp,
  `Carol@MegaCorp.net` in Marketo). Lowercase before dedup.
- ~5% of CSV rows are exact duplicates of earlier CSV rows (the campaign
  team re-uploads spreadsheets without dedup).
- ~2% of CSV rows have an email that fails RFC-5322 format validation
  (typos like `alice@acmecom`). These should be excluded from
  `unified_contacts` but logged for follow-up.
- Marketo has a handful of leads with `Email = NULL` despite the column
  being NOT NULL — turns out it's a sentinel `' '` (single space). Filter
  out before dedup.
- Mailchimp's `tags` field sometimes has trailing whitespace and inconsistent
  comma placement (`"newsletter,beta"` vs `"newsletter, beta"`). Normalize
  on whitespace.

## Scope decisions

- **Out of scope:** Salesforce / HubSpot CRM data (the customer is on
  HubSpot but doesn't want it included in this warehouse — they'll join
  separately downstream).
- **Out of scope:** Email engagement history (opens, clicks). Only the
  contact identity goes into `unified_contacts`.
- **Out of scope:** Marketo activity timeline (web visits, form fills).
  Same reason as above.
- The customer accepts that the dedup may merge a small number of records
  that are actually different people sharing an email (e.g., shared work
  email). They'll handle the long-tail manually post-migration.
