import { GuideLayout, Section, Paragraph } from '../GuideLayout'

export default function SchemaDataUnderstandingGuide() {
  return (
    <GuideLayout
      title="Schema & data understanding"
      description="Schema overview, data preview, query data, data profiling"
    >
      <Section title="Schema overview">
        <Paragraph>
          View all source and target tables side by side. Expand any table to see its fields
          with data types, nullability, primary/foreign keys, and constraints.
        </Paragraph>
      </Section>

      <Section title="Data preview">
        <Paragraph>
          Browse actual data rows for any table. Toggle between Source Data (raw uploaded data)
          and Transformed Data (data after transformations are applied). The transformed view
          highlights which fields have been transformed and flags any constraint violations.
        </Paragraph>
      </Section>

      <Section title="Query data">
        <Paragraph>
          Explore your data using natural language or SQL. Type a question like &quot;How many
          employees are in each department?&quot; and Settle generates and executes the SQL query.
          Results are displayed inline with row counts and execution metadata.
        </Paragraph>
        <Paragraph>
          The Available Tables sidebar shows all source and target tables with their fields
          for easy reference. Click any table or field name to copy it to your clipboard.
        </Paragraph>
      </Section>

      <Section title="Data profiling">
        <Paragraph>
          Select any table to view field-level statistics: null percentage, cardinality
          (distinct values), unique percentage, and data quality status. Fields with quality
          issues are flagged with issue counts — click any issue count to see detailed
          information and affected rows.
        </Paragraph>
      </Section>
    </GuideLayout>
  )
}
