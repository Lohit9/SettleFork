import Link from 'next/link'
import {
  Download,
  ChevronRight,
  Eye,
  GitBranch,
  Code,
} from '@/components/icons'
import {
  Mail,
  CalendarDays,
  Rocket,
  ShieldCheck,
  Package,
} from 'lucide-react'

// ── Static data ───────────────────────────────────────────────────────────────

const DOC_CATEGORIES = [
  {
    slug: 'getting-started',
    icon: Rocket,
    name: 'Getting started',
    description: 'Create your first project, upload schemas, and generate mappings',
  },
  {
    slug: 'data-ingestion',
    icon: Download,
    name: 'Data ingestion',
    description: 'CSV uploads, DDL parsing, database connections, schema documents',
  },
  {
    slug: 'schema-data-understanding',
    icon: Eye,
    name: 'Schema & data understanding',
    description: 'Schema overview, data preview, query data, data profiling',
  },
  {
    slug: 'field-mappings',
    icon: GitBranch,
    name: 'Field mappings',
    description: 'AI-powered mappings, confidence scores, manual overrides, approval workflow',
  },
  {
    slug: 'transforms',
    icon: Code,
    name: 'Transformations',
    description: 'Natural language transforms, SQL generation, testing, staging',
  },
  {
    slug: 'data-quality',
    icon: ShieldCheck,
    name: 'Data quality & validation',
    description: 'Validation rules, AI fixes, readiness scoring, fix history',
  },
  {
    slug: 'deliverables-outputs',
    icon: Package,
    name: 'Deliverables & outputs',
    description: 'Migration scripts, gold standard files, readiness reports, mapping exports',
  },
]

const FAQS = [
  {
    q: 'Which source systems does Settle support?',
    a: 'Settle currently supports CSV uploads for any source system and DDL/SQL schema parsing for Salesforce, SAP, Oracle, SQL Server, MySQL, PostgreSQL, and NetSuite. Direct database connections are on the roadmap.',
  },
  {
    q: 'How does AI mapping work?',
    a: 'Settle analyzes field names, data types, sample values, and uploaded schema documentation to propose source-to-target field mappings with confidence scores. Every AI suggestion is a proposal — you review, approve, edit, or reject before anything is applied.',
  },
  {
    q: 'Can I revert a data fix?',
    a: 'Yes. Every fix is fully reversible. Settle snapshots the complete pre-fix state of every affected row before applying changes. You can revert any fix from the Fix History panel to restore exact original values.',
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
    <div className="flex-1 bg-gray-50 min-h-screen overflow-auto">
      <div className="max-w-3xl mx-auto py-8 px-6 space-y-6">

        {/* ── Contact banner ──────────────────────────────────────── */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-base font-semibold text-gray-900">
                Need help with your migration?
              </h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Our team typically responds within a few hours.
              </p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <a
                href="mailto:info@usesettle.ai?subject=Support%20Request"
                className="flex items-center gap-2 h-9 px-4 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <Mail className="w-4 h-4" />
                Email us
              </a>
              <a
                href="https://calendly.com/settle-ai/migration-scoping-call"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 h-9 px-4 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
              >
                <CalendarDays className="w-4 h-4" />
                Schedule a walkthrough
              </a>
            </div>
          </div>
        </div>

        {/* ── Documentation ───────────────────────────────────────── */}
        <div>
          <p className="text-sm font-semibold text-gray-900 mb-3">Documentation</p>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
            {DOC_CATEGORIES.map((cat) => (
              <Link
                key={cat.slug}
                href={`/app/support/guides/${cat.slug}`}
                className="flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors group"
              >
                <cat.icon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 group-hover:text-primary transition-colors">
                    {cat.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{cat.description}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
              </Link>
            ))}
          </div>
        </div>

        {/* ── FAQ ──────────────────────────────────────────────────── */}
        <div>
          <p className="text-sm font-semibold text-gray-900 mb-3">Frequently asked questions</p>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
            {FAQS.map((faq, i) => (
              <details key={i}>
                <summary className="flex justify-between items-center py-3.5 px-5 cursor-pointer text-sm font-medium text-gray-900 list-none [&::-webkit-details-marker]:hidden select-none hover:bg-gray-50">
                  {faq.q}
                  <span className="text-gray-400 text-base ml-4 flex-shrink-0">+</span>
                </summary>
                <div className="px-5 pb-4 text-sm text-gray-500 leading-relaxed">
                  {faq.a}
                </div>
              </details>
            ))}
          </div>
        </div>

        {/* ── Contact + Feature request ────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <p className="text-sm font-medium text-gray-900 mb-1.5">Contact support</p>
            <p className="text-xs text-gray-500 leading-relaxed mb-3">
              Need help with your migration? Our team typically responds within a few hours.
            </p>
            <a
              href="mailto:info@usesettle.ai?subject=Support%20Request"
              className="text-sm text-primary hover:text-primary/80 font-medium"
            >
              info@usesettle.ai
            </a>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <p className="text-sm font-medium text-gray-900 mb-1.5">Request a feature</p>
            <p className="text-xs text-gray-500 leading-relaxed mb-3">
              Have an idea for how Settle could work better for your team? We&apos;d love to hear it.
            </p>
            <a
              href="mailto:feedback@usesettle.ai?subject=Feature%20Request"
              className="text-sm text-primary hover:text-primary/80 font-medium"
            >
              Share feedback
            </a>
          </div>
        </div>

      </div>
    </div>
  )
}
