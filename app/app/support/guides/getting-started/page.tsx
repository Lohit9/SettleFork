import Link from 'next/link'

function BoxIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  )
}

function StepBadge({ n }: { n: number }) {
  return (
    <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-medium flex-shrink-0">
      {n}
    </div>
  )
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mt-3">
      <p className="text-xs font-semibold text-blue-700 mb-1">💡 Tip</p>
      <p className="text-sm text-blue-700 leading-relaxed">{children}</p>
    </div>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-gray-600 leading-relaxed">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" />
          {item}
        </li>
      ))}
    </ul>
  )
}

export default function GettingStartedPage() {
  return (
    <div className="flex-1 bg-gray-50 min-h-screen overflow-auto">
        <div className="max-w-3xl mx-auto py-8 px-6">

          {/* Back link */}
          <Link
            href="/app/support"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
          >
            <span>←</span>
            Back to Help Center
          </Link>

          {/* Header */}
          <div className="flex items-start gap-4 mb-8">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
              <BoxIcon className="text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Getting started with Settle</h1>
              <p className="text-sm text-gray-500 mt-1">
                Go from raw data to AI-powered field mappings in under 5 minutes
              </p>
            </div>
          </div>

          {/* Steps */}
          <div className="space-y-8">

            {/* Step 1 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={1} />
                <h2 className="text-lg font-medium text-gray-900">Create a project</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Your migration project is the container for everything — source data, target schemas,
                mappings, transforms, and validation results. Each project represents one migration
                engagement (e.g., &quot;Legacy CRM to Salesforce&quot; or &quot;SAP ECC to NetSuite&quot;).
              </p>
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
            </div>

            {/* Step 2 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={2} />
                <h2 className="text-lg font-medium text-gray-900">Upload your source data</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                In Project Setup, select <strong>CSV Upload</strong> as your source ingestion method.
                Upload one CSV per table — each file becomes a table in your source schema.
              </p>
              <BulletList items={[
                'Settle auto-detects column names, data types, primary keys, and foreign key relationships',
                'You\'ll see a confirmation with row count and field count after each upload',
                'Max file size: 10MB per CSV, up to 100,000 rows per table',
              ]} />
              <Tip>
                Upload schema documentation too (PDFs, DDL files, ERD diagrams) in the Schema
                Documents section below. Settle uses these to make smarter mapping suggestions.
              </Tip>
            </div>

            {/* Step 3 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={3} />
                <h2 className="text-lg font-medium text-gray-900">Define your target schema</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Select <strong>DDL / Schema Upload</strong> for your target side. Upload a{' '}
                <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">.sql</code> or{' '}
                <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">.ddl</code> file
                containing your target system&apos;s CREATE TABLE statements.
              </p>
              <BulletList items={[
                'Settle parses standard SQL, SQL Server, Oracle, SAP HANA, MySQL, and PostgreSQL dialects',
                'If parsing fails, Settle\'s AI fallback will interpret non-standard syntax',
                'You can also upload CSVs for the target side if you don\'t have DDL files',
              ]} />
            </div>

            {/* Step 4 */}
            <div className="border-b border-gray-200 pb-8">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={4} />
                <h2 className="text-lg font-medium text-gray-900">Explore your data</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Head to <strong>Data Overview</strong> to see your source and target schemas side by
                side. Four sub-tabs give you full visibility:
              </p>
              <BulletList items={[
                'Schema Overview — side-by-side table and field comparison with the Generate Mappings button',
                'Data Preview — paginated row-level view of your source data',
                'Query Data — ask questions in plain English or write SQL directly',
                'Data Profiling — null rates, cardinality, unique percentages, and format issues per field',
              ]} />
            </div>

            {/* Step 5 */}
            <div className="pb-4">
              <div className="flex items-center gap-3 mb-3">
                <StepBadge n={5} />
                <h2 className="text-lg font-medium text-gray-900">Generate AI mappings</h2>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed max-w-2xl">
                Click <strong>Generate Mappings</strong> from the Schema Overview tab. Settle&apos;s AI
                analyzes field names, data types, sample values, and your uploaded documentation to
                propose source-to-target field mappings.
              </p>
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
            </div>

          </div>

          {/* CTA */}
          <div className="mt-10 bg-white border border-gray-200 rounded-xl p-6 text-center">
            <p className="text-base font-medium text-gray-900 mb-1">Ready to start your first migration?</p>
            <p className="text-sm text-gray-500 mb-4">Create a project and follow these steps in the app.</p>
            <Link
              href="/app/projects"
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
            >
              Go to Projects →
            </Link>
          </div>

        </div>
      </div>
  )
}
