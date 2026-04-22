<project>
Name: Heritage Core Migration
Source: Legacy CRM (2 tables, 350 rows)
Target: Modern ERP (2 tables)
</project>

<readiness>
Score: 82%
Status: Ready with Conditions
</readiness>

<mapping_summary>
Total source fields: 9
Approved field mappings: 7 source fields → 7 target fields (78% source coverage)
Value assignments (no source field): 1
Unmapped source fields: 2
Approved table mappings: 2
Rejected mappings: 1
Average confidence: 90%
</mapping_summary>

<quality_summary>
Open blocking issues: 0
Open warnings: 0
Fixed issues: 0
Accepted risks: 0
Active validation rules: 0
</quality_summary>

<quality_issues_detail>
No open issues.
</quality_issues_detail>

<accepted_risks>
No accepted risks.
</accepted_risks>

<transformations>
Total transforms: 7
Saved: 1
Tested: 0
Draft: 0
- Cast s_id to integer.: `(row_data->>'s_id')::integer`
</transformations>

<fix_history>
No fixes applied.
</fix_history>

Generate the full Migration Readiness Report now.