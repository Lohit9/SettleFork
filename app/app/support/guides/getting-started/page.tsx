import Link from 'next/link'
import { GuideLayout, Section, Paragraph, BulletList } from '../GuideLayout'

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mt-3 mb-3 last:mb-0">
      <p className="text-xs font-semibold text-blue-700 mb-1">💡 Tip</p>
      <p className="text-sm text-blue-700 leading-relaxed">{children}</p>
    </div>
  )
}

export default function GettingStartedPage() {
  return (
    <GuideLayout
      title="Getting started"
      description="Create your first project, upload schemas, and generate mappings in under 5 minutes"
    >
      <Section title="1. Create a project">
        <Paragraph>
          Your migration project is the container for everything — source data, target schemas,
          mappings, transforms, and validation results. Each project represents one migration
          engagement (e.g., &quot;Legacy CRM to Salesforce&quot; or &quot;SAP ECC to NetSuite&quot;).
        </Paragraph>
        <BulletList items={[
          'Click + New Project from the Projects page',
          'Give it a name, source system label, and target system label',
          'You\'ll land in Project Setup — your project\'s command center',
        ]} />
        <Tip>
          Name projects descriptively. If you&apos;re running multiple migrations for the same
          client, include the scope — e.g., &quot;Site 12: SAP to NetSuite&quot; rather than
          just &quot;Q1 Migration.&quot;
        </Tip>
      </Section>

      <Section title="2. Upload your source data">
        <Paragraph>
          In Project Setup, select <strong>CSV Upload</strong> as your source ingestion method.
          Upload one CSV per table — each file becomes a table in your source schema.
        </Paragraph>
        <BulletList items={[
          'Settle auto-detects column names, data types, primary keys, and foreign key relationships',
          'You\'ll see a confirmation with row count and field count after each upload',
          'Max file size: 250MB per CSV, up to 1,000,000 rows per table',
        ]} />
        <Tip>
          Upload schema documentation too (PDFs, DDL files, ERD diagrams) in the Schema
          Documents section below. Settle uses these to make smarter mapping suggestions.
        </Tip>
      </Section>

      <Section title="3. Define your target schema">
        <Paragraph>
          Select <strong>DDL / Schema Upload</strong> for your target side. Upload a{' '}
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">.sql</code> or{' '}
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">.ddl</code> file
          containing your target system&apos;s CREATE TABLE statements.
        </Paragraph>
        <BulletList items={[
          'Settle parses standard SQL, SQL Server, Oracle, SAP HANA, MySQL, and PostgreSQL dialects',
          'If parsing fails, Settle\'s AI fallback will interpret non-standard syntax',
          'You can also upload CSVs for the target side if you don\'t have DDL files',
        ]} />
      </Section>

      <Section title="4. Explore your data">
        <Paragraph>
          Head to <strong>Data Overview</strong> to see your source and target schemas side by
          side. Four sub-tabs give you full visibility:
        </Paragraph>
        <BulletList items={[
          'Schema Overview — side-by-side table and field comparison with the Generate Mappings button',
          'Data Preview — paginated row-level view of your source data',
          'Query Data — ask questions in plain English or write SQL directly',
          'Data Profiling — null rates, cardinality, unique percentages, and format issues per field',
        ]} />
      </Section>

      <Section title="5. Generate AI mappings">
        <Paragraph>
          Click <strong>Generate Mappings</strong> from the Schema Overview tab. Settle&apos;s AI
          analyzes field names, data types, sample values, and your uploaded documentation to
          propose source-to-target field mappings.
        </Paragraph>
        <BulletList items={[
          'Each mapping gets a confidence score (0–100%)',
          'Review mappings in the Mapping tab — approve, edit, or reject each one',
          'Use AI Suggest Remaining for unmapped fields, or drag-to-map manually',
          'Click Proceed to Transform when you\'re satisfied',
        ]} />
        <Tip>
          You don&apos;t need to approve every mapping before moving forward. Settle works
          iteratively — you can come back and refine mappings at any point.
        </Tip>
      </Section>

      <Section title="Ready to start your first migration?">
        <Paragraph>
          Create a project and follow these steps in the app.
        </Paragraph>
        <Link
          href="/app/projects"
          className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
        >
          Go to Projects →
        </Link>
      </Section>
    </GuideLayout>
  )
}
