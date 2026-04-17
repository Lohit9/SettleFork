import { GuideLayout, Section, Paragraph, BulletList } from '../GuideLayout'

export default function DataIngestionGuide() {
  return (
    <GuideLayout
      title="Data ingestion"
      description="CSV uploads, DDL parsing, database connections, schema documents"
    >
      <Section title="CSV upload">
        <Paragraph>
          Upload one CSV file per table. Settle automatically infers the schema — column names,
          data types, nullability, and primary keys. Files must be under 10MB with a maximum
          of 100,000 rows.
        </Paragraph>
        <Paragraph>
          After uploading, you can re-upload a CSV to replace the data for any table. Settle
          will prompt you to confirm before overwriting existing data.
        </Paragraph>
      </Section>

      <Section title="DDL / Schema upload">
        <Paragraph>
          For target systems, upload a DDL or SQL file instead of CSV data. Settle parses
          standard SQL, SQL Server, Oracle, SAP HANA, MySQL, and PostgreSQL dialects to
          extract table and field definitions.
        </Paragraph>
        <Paragraph>
          Accepted file types: .sql, .ddl, .txt (max 2MB).
        </Paragraph>
      </Section>

      <Section title="Database connections">
        <Paragraph>
          Connect directly to a source or target database using read-only credentials. Settle
          supports PostgreSQL, MySQL, SQL Server, and Oracle connections. All connections are
          encrypted and read-only — Settle never writes to your production databases.
        </Paragraph>
      </Section>

      <Section title="Supporting documents">
        <Paragraph>
          Upload additional context to improve AI accuracy:
        </Paragraph>
        <BulletList items={[
          'Schema documentation: ERDs, data dictionaries, DDL scripts — helps verify and enrich inferred schemas.',
          'Business context: Migration requirements, business rules, value mappings — informs AI reasoning for mappings and transformations.',
        ]} />
      </Section>
    </GuideLayout>
  )
}
