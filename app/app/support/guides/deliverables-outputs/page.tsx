import { GuideLayout, Section, Paragraph, BulletList } from '../GuideLayout'

export default function DeliverablesOutputsGuide() {
  return (
    <GuideLayout
      title="Deliverables & outputs"
      description="Migration scripts, gold standard files, readiness reports, mapping exports"
    >
      <Section title="Migration execution package">
        <Paragraph>
          A complete SQL migration script with extract queries, transformation logic, load
          scripts, post-load validation queries, and rollback procedures. Choose your target
          SQL dialect (PostgreSQL, T-SQL, MySQL, Oracle, SAP HANA) and download per-table or
          single-file scripts.
        </Paragraph>
      </Section>

      <Section title="Import-ready files">
        <Paragraph>
          Production-ready data files (CSV) with all transformations applied. These can be
          loaded directly into your target system using its native import tools.
        </Paragraph>
      </Section>

      <Section title="Deliverable package">
        <Paragraph>
          Generate documentation for stakeholders and project records:
        </Paragraph>
        <BulletList items={[
          'Migration Runbook — step-by-step execution guide.',
          'Readiness Report — go/no-go recommendation based on current data quality.',
          'Mapping File — complete field-to-field mapping specification (CSV or JSON).',
          'Transformation Specs — SQL transforms with field context.',
          'Fix Log & Audit Trail — chronological record of all fixes applied.',
          'Data Dictionary — schema documentation with data types.',
        ]} />
      </Section>
    </GuideLayout>
  )
}
