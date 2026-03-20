import type { Metadata } from 'next'
import Header from '@/components/Header'
import Footer from '@/components/Footer'

export const metadata: Metadata = {
  title: 'Use Cases | Mine',
  description: 'How enterprise teams use Mine for ERP, CRM, M&A, and cloud data migration automation.',
}

const USE_CASES = [
  {
    icon: '🏢',
    title: 'ERP migrations',
    description:
      'Migrating from SAP, Oracle, or legacy ERPs to modern platforms like NetSuite or Dynamics 365. Mine handles the complex schema transformations and validates data against target constraints before every load.',
    tags: ['SAP', 'Oracle', 'NetSuite'],
  },
  {
    icon: '🤝',
    title: 'CRM migrations',
    description:
      'Moving between Salesforce, HubSpot, Dynamics, or custom CRMs. Mine auto-maps contact, account, and opportunity schemas while preserving picklist values, relationships, and business rules.',
    tags: ['Salesforce', 'HubSpot', 'Dynamics 365'],
  },
  {
    icon: '🔀',
    title: 'M&A data consolidation',
    description:
      'Merging data across acquired entities into a single system of record. Mine profiles overlapping schemas, resolves conflicts, and standardizes data across multiple source systems simultaneously.',
    tags: ['Multi-source', 'Deduplication', 'Schema merge'],
  },
  {
    icon: '☁️',
    title: 'Cloud & platform migrations',
    description:
      'Lifting data from on-premise systems to cloud platforms. Mine generates the ETL, validates referential integrity, and handles iterative delta loads so you can migrate in phases without downtime.',
    tags: ['AWS', 'Azure', 'Snowflake'],
  },
]

export default function UseCasesPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Header />

      <main className="flex-1">
        <div className="max-w-5xl mx-auto py-24 px-6">

          {/* Hero */}
          <h1 className="text-4xl lg:text-5xl font-bold text-[#0F172A] tracking-tight mb-4 text-center">
            Use Cases
          </h1>
          <p className="text-lg text-[#64748B] leading-relaxed text-center max-w-2xl mx-auto mb-16">
            Mine automates the hardest parts of enterprise data migration — wherever legacy data needs to move.
          </p>

          {/* Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {USE_CASES.map((uc) => (
              <div
                key={uc.title}
                className="bg-white rounded-2xl p-8 border border-[#E2E8F0] hover:-translate-y-1 hover:shadow-xl transition-all duration-300"
              >
                <div className="w-10 h-10 bg-[#EFF6FF] rounded-lg flex items-center justify-center mb-4 text-lg">
                  {uc.icon}
                </div>
                <h2 className="text-xl font-bold text-[#0F172A] mb-2">{uc.title}</h2>
                <p className="text-sm text-[#64748B] leading-relaxed">{uc.description}</p>
                <div className="flex flex-wrap gap-2 mt-4">
                  {uc.tags.map((tag) => (
                    <span
                      key={tag}
                      className="bg-[#F1F5F9] text-[#475569] text-xs px-2.5 py-1 rounded-full"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Bottom CTA */}
          <div className="mt-16 text-center">
            <p className="text-[#64748B] text-base mb-4">
              Have a migration program we should know about?
            </p>
            <a
              href="https://calendly.com/trymine-info/demo"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg shadow-blue-600/20 hover:-translate-y-0.5 transition-all text-sm"
            >
              Book a Demo
            </a>
          </div>

        </div>
      </main>

      <Footer />
    </div>
  )
}
