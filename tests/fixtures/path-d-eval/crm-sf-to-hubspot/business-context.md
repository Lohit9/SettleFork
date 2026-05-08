# CRM migration — Salesforce Leads → HubSpot Contacts

## Overview

The customer is a 60-employee B2B SaaS company sunsetting their Salesforce
instance and consolidating onto HubSpot CRM. They've been on Salesforce for
~4 years and have ~2,500 lead records with mixed quality.

This migration moves the `leads` table from Salesforce into HubSpot's
`contacts` object. Salesforce's lead/contact split (Lead = unqualified, Contact
= qualified-and-converted) collapses into HubSpot's unified Contact entity
with a `lifecycle_stage` field that captures the same gradient.

## Migration goals

- **Preserve all qualified leads** (`is_converted = true` in Salesforce →
  `lifecycle_stage = 'salesqualifiedlead'` or higher in HubSpot)
- **Normalize names** into a single `fullname` field (HubSpot doesn't split
  first/last; combine via `concat_space`)
- **Normalize emails** to lowercase + dedupe (Salesforce allows duplicate
  emails on Leads; HubSpot enforces UNIQUE on `email_primary`)
- **Map LeadStatus → lifecycle_stage** via a new lookup table the customer's
  CRM admin will own going forward
- **Resolve owner** via Salesforce User Id → HubSpot user email (the customer
  has provided a separate user mapping that's already been applied; this
  migration just needs to reflect the resolved emails)

## Known data-quality concerns

- ~4% of lead emails are duplicates (same email, different lead records)
- ~0.3% of lead emails fail format validation (missing `@` or domain)
- Phone numbers are free-form: mix of `(555) 123-4567`, `+1-555-234-5678`,
  `555.345.6789`, etc. HubSpot expects E.164 — needs normalization in transform
- Some leads have null `created_date` (data-import artifact from a prior
  migration); these should default to NOW() at insert

## Scope decisions

- **Out of scope:** Salesforce Activities (call logs, emails). The customer
  is not migrating activity history.
- **Out of scope:** Custom fields. The schema above is the canonical set.
- The customer accepts that a single Salesforce Lead Id won't survive the
  migration (HubSpot generates new Contact IDs); they'll keep an audit table
  separately mapping old SF Lead Id → new HubSpot Contact Id.
