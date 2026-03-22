import Link from 'next/link'
import SidebarShell from '@/components/app/SidebarShell'
import { CheckCircle, RefreshCw, Download } from '@/components/icons'

// ── Inline SVGs for icons not in the custom icon lib ─────────────────────────

function BoxIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
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

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function PackageIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.29 7 12 12 20.71 7" />
      <line x1="12" y1="22" x2="12" y2="12" />
    </svg>
  )
}

// ── Static data ───────────────────────────────────────────────────────────────

const DOC_CATEGORIES = [
  {
    icon: <Download className="w-4 h-4 text-gray-500" />,
    name: 'Data ingestion',
    description: 'CSV uploads, DDL parsing, schema documents',
    articles: 4,
  },
  {
    icon: <LinkIcon className="text-gray-500" />,
    name: 'Schema mapping',
    description: 'AI-powered mappings, confidence scores, manual overrides',
    articles: 6,
  },
  {
    icon: <RefreshCw className="w-4 h-4 text-gray-500" />,
    name: 'Transformations',
    description: 'Natural language transforms, SQL generation, testing',
    articles: 5,
  },
  {
    icon: <CheckCircle className="w-4 h-4 text-gray-500" />,
    name: 'Data quality & validation',
    description: 'Validation rules, AI fixes, readiness scoring, fix history',
    articles: 8,
  },
  {
    icon: <PackageIcon className="text-gray-500" />,
    name: 'Deliverables & outputs',
    description: 'Gold standard files, readiness reports, mapping exports',
    articles: 3,
  },
]

const FAQS = [
  {
    q: 'Which source systems does Mine support?',
    a: 'Mine currently supports CSV uploads for any source system and DDL/SQL schema parsing for Salesforce, SAP, Oracle, SQL Server, MySQL, PostgreSQL, and NetSuite. Direct database connections are on the roadmap.',
  },
  {
    q: 'How does AI mapping work?',
    a: 'Mine analyzes field names, data types, sample values, and uploaded schema documentation to propose source-to-target field mappings with confidence scores. Every AI suggestion is a proposal — you review, approve, edit, or reject before anything is applied.',
  },
  {
    q: 'Can I revert a data fix?',
    a: 'Yes. Every fix is fully reversible. Mine snapshots the complete pre-fix state of every affected row before applying changes. You can revert any fix from the Fix History panel to restore exact original values.',
  },
  {
    q: 'What does the Migration Readiness Score measure?',
    a: 'The readiness score (0–100%) reflects how prepared your data is to load into the target system. It accounts for blocking issues, unmapped fields, untested transforms, and data quality violations. A score above 90% is generally considered production-ready.',
  },
  {
    q: 'Is my data secure?',
    a: 'Yes. All data is isolated per user with Row-Level Security. Your data is never used to train AI models. All AI-generated SQL is validated before execution, and all fixes are logged with complete audit trails.',
  },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SupportPage() {
  return (
    <SidebarShell>
      <div className="flex-1 bg-gray-50 min-h-screen overflow-auto">
        <div className="max-w-3xl mx-auto py-10 px-6 space-y-8">

          {/* ── Hero header ───────────────────────────────────────────────── */}
          <div className="text-center space-y-3">
            <h1 className="text-2xl font-semibold text-gray-900">How can we help?</h1>
            <p className="text-sm text-gray-500">
              Search docs, explore guides, or reach out to our team
            </p>
            <div className="max-w-md mx-auto pt-1">
              <input
                type="text"
                placeholder="Search for help…"
                className="w-full h-10 px-4 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#4F46E5] focus:border-[#4F46E5] transition-colors"
                readOnly
              />
            </div>
          </div>

          {/* ── Quick start cards ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Link href="/app/support/guides/getting-started" className="bg-white border border-gray-200 rounded-xl p-5 hover:border-gray-300 hover:shadow-sm transition-all">
              <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center mb-3">
                <BoxIcon className="text-blue-600" />
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1.5">Getting started</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                Create your first project, upload schemas, and generate mappings in under 5 minutes.
              </p>
            </Link>

            <Link href="/app/support/guides/data-quality" className="bg-white border border-gray-200 rounded-xl p-5 hover:border-gray-300 hover:shadow-sm transition-all">
              <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center mb-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1.5">Data quality guide</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                Understand validation rules, fix workflows, and how to get your migration to 100% readiness.
              </p>
            </Link>

            <Link href="/app/support/guides/transforms" className="bg-white border border-gray-200 rounded-xl p-5 hover:border-gray-300 hover:shadow-sm transition-all">
              <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center mb-3">
                <RefreshCw className="w-5 h-5 text-amber-600" />
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1.5">Transform reference</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                Write natural language transforms, review generated SQL, and test before applying.
              </p>
            </Link>
          </div>

          {/* ── Documentation ─────────────────────────────────────────────── */}
          <div>
            <p className="text-base font-medium text-gray-900 mb-3">Documentation</p>
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {DOC_CATEGORIES.map((cat, i) => (
                <div
                  key={cat.name}
                  className={`flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 cursor-pointer transition-colors ${
                    i < DOC_CATEGORIES.length - 1 ? 'border-b border-gray-100' : ''
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="flex-shrink-0 mt-0.5">{cat.icon}</div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{cat.name}</p>
                      <p className="text-xs text-gray-500 truncate">{cat.description}</p>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 flex-shrink-0 ml-4">{cat.articles} articles</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── FAQ ───────────────────────────────────────────────────────── */}
          <div>
            <p className="text-base font-medium text-gray-900 mb-3">Frequently asked questions</p>
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {FAQS.map((faq, i) => (
                <details
                  key={i}
                  className={i < FAQS.length - 1 ? 'border-b border-gray-100' : ''}
                >
                  <summary className="flex justify-between items-center py-3.5 px-5 cursor-pointer text-sm font-medium text-gray-900 list-none [&::-webkit-details-marker]:hidden select-none hover:bg-gray-50">
                    {faq.q}
                    <span className="text-gray-400 text-base ml-4 flex-shrink-0">+</span>
                  </summary>
                  <div className="px-5 pb-4 text-sm text-gray-500 leading-relaxed">{faq.a}</div>
                </details>
              ))}
            </div>
          </div>

          {/* ── Contact ───────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-sm font-medium text-gray-900 mb-1.5">Contact support</p>
              <p className="text-xs text-gray-500 leading-relaxed mb-3">
                Need help with your migration? Our team typically responds within a few hours.
              </p>
              <a
                href="mailto:info@trymine.ai"
                className="text-sm text-[#4F46E5] hover:underline"
              >
                info@trymine.ai
              </a>
            </div>

            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-sm font-medium text-gray-900 mb-1.5">Request a feature</p>
              <p className="text-xs text-gray-500 leading-relaxed mb-3">
                Have an idea for how Mine could work better for your team? We&apos;d love to hear it.
              </p>
              <a
                href="mailto:feedback@trymine.ai"
                className="text-sm text-[#4F46E5] hover:underline"
              >
                Share feedback
              </a>
            </div>
          </div>

          {/* ── Footer ────────────────────────────────────────────────────── */}
          <div className="text-center text-xs text-gray-400 pb-2">
            Mine v0.1.0
            <span className="mx-2">·</span>
            <span className="hover:text-gray-600 cursor-pointer">Release notes</span>
            <span className="mx-2">·</span>
            <span className="hover:text-gray-600 cursor-pointer">Status page</span>
          </div>

        </div>
      </div>
    </SidebarShell>
  )
}
