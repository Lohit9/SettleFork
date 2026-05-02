# NetSuite → Rootstock calibration sample (DRAFT — archived from PR 10.5a)

**Status:** archived draft. NOT loaded by the eval harness.

This directory contains a 5-mapping + 1-validation calibration sample
authored by Claude Code in PR 10.5a from public NetSuite SuiteScript
docs and Rootstock Object Reference (the latter only available behind
the customer center login).

The sample was archived rather than committed to `tests/eval/datasets/`
because we lack domain confidence in the gold labels — specifically
the address structure, currency field naming, external-ID convention,
and order-total field naming on Rootstock-installed schemas.

Per `docs/methodology.md`, Settle's measurement methodology relies on
gold labels that come from real customer migrations via
`ai_edit_history`, not from synthetic datasets fabricated from public
docs. This draft is preserved as a starting point for if/when:

1. A Rootstock-savvy domain reviewer (e.g., Caroline Marty's pilot at
   Rootstock) validates the gold labels with ground truth, OR
2. Real `ai_edit_history` data accumulates from NetSuite-to-Rootstock
   customer migrations, at which point synthetic gold labels become
   redundant.

## Files preserved

- `schema.json` — partial NetSuite + Rootstock schema (2 tables each)
- `metadata.json` — dataset metadata
- `examples/mapping/` — 5 mapping examples with doc citations
  - `001-customer-id-pair.json` — easy: NetSuite `Customer.entityid` → Rootstock `Customer__c.External_ID__c`
  - `002-customer-name-pair.json` — easy: NetSuite `Customer.companyname` → Rootstock `Customer__c.Name`
  - `003-customer-currency.json` — medium: NetSuite `Customer.currency` → Rootstock `Customer__c.Currency_Code__c`
  - `004-salesorder-amount.json` — medium: NetSuite `SalesOrder.total` → Rootstock `Sales_Order__c.Total_Amount__c`
  - `005-customer-address-concat.json` — hard: NetSuite address fields concat → Rootstock `Customer__c.Billing_Address__c`
- `examples/validation-rule/001-customer-email-format.json` — RFC 5322 simplified email format

## Open uncertainty flags (the working punchlist for promoting this draft)

1. **Address structure (example 005):** Single TextArea concat (gold as authored)
   vs structured `BillingStreet`/`BillingCity`/etc sub-fields on a related
   Account record. The two answers are STRUCTURALLY different — affects
   whether 005 is many-to-one (concat) or four one-to-one mappings.

2. **Currency field (example 003):** `Customer__c.Currency_Code__c`
   (Rootstock-custom, gold) vs `CurrencyIsoCode` (Salesforce multicurrency
   standard).

3. **External-ID field (example 001):** `External_ID__c` (gold) vs
   `Account_Number__c` vs `Customer_Number__c`. Three candidate target
   fields; which is canonical for NetSuite-to-Rootstock migrations.

4. **Order-total field (example 004):** `Total_Amount__c` (gold) vs
   `Amount__c` vs `Order_Total__c`. Same disambiguation question.

5. **Validation severity:** `'warning'` (gold, operationally pragmatic
   for legacy-data migrations) vs `'blocking'` (some SOC 2-aligned
   project policies require blocking on PII format violations).

6. **JOIN spec / rounding rules — mapping vs transform layer:** Should
   the mapping examples surface `join_spec` (currency JOIN) or rounding
   (currency precision), or are those strictly transform-layer concerns.
   Current gold says transform-layer.

## Provenance

Authored by Claude Code, May 2, 2026. Sub-commit `f86ea66` of the
PR 10.5a feature branch (which was reset and dropped from PR #17's
merged history). Re-archived here in a follow-up docs PR after Phase 1
closeout because the schema research and example structure remain
useful as starting points for future Rootstock-domain-validated work.
