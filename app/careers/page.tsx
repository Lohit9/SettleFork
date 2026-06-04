import type { Metadata } from 'next'
import Link from 'next/link'
import Header from '@/components/Header'
import Footer from '@/components/Footer'

export const metadata: Metadata = {
  title: 'Careers — Settle',
  description:
    'Help build the AI-native version of enterprise data migration. View open roles at Settle.',
  openGraph: {
    title: 'Careers — Settle',
    description:
      'Help build the AI-native version of enterprise data migration. View open roles at Settle.',
    url: 'https://settledata.ai/careers',
    siteName: 'Settle',
    type: 'website',
    images: [
      {
        url: 'https://settledata.ai/images/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Careers at Settle',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Careers — Settle',
    description:
      'Help build the AI-native version of enterprise data migration.',
    images: ['https://settledata.ai/images/og-image.png'],
  },
}

interface OpenRole {
  slug: string
  title: string
  tagline: string
  location: string
}

const OPEN_ROLES: OpenRole[] = [
  {
    slug: 'co-founder-cto',
    title: 'Co-Founder & CTO',
    tagline: 'Build the technical side of Settle alongside the founder.',
    location: 'NYC',
  },
]

export default function CareersIndexPage() {
  return (
    <>
      <Header />
      <main>
        {/* Hero */}
        <section className="px-6 pt-12 pb-12 md:pt-20 md:pb-16">
          <div className="max-w-4xl mx-auto text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-settle-blue-600 mb-5">
              Careers · Now hiring
            </p>
            <h1 className="text-4xl md:text-6xl font-bold text-[#0F172A] tracking-tight leading-[1.1]">
              Careers at Settle
            </h1>
            <p className="text-lg md:text-xl text-[#475569] mt-6 max-w-2xl mx-auto leading-relaxed">
              Help build the AI-native version of enterprise data migration.
            </p>
          </div>
        </section>

        {/* Open roles */}
        <section className="px-6 pb-24">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl md:text-3xl font-bold text-[#0F172A] tracking-tight mb-6">
              Open roles
            </h2>
            <ul className="space-y-4">
              {OPEN_ROLES.map((role) => (
                <li key={role.slug}>
                  <Link href={`/careers/${role.slug}`}
                        className="block group rounded-2xl border border-[#E2E8F0] bg-white p-6 md:p-8 hover:border-settle-blue-500 hover:shadow-md transition-all">
                    <div className="flex items-start justify-between gap-4 flex-col md:flex-row md:items-center">
                      <div>
                        <h3 className="text-xl md:text-2xl font-semibold text-[#0F172A] mb-1.5 group-hover:text-settle-blue-600 transition-colors">
                          {role.title}
                        </h3>
                        <p className="text-[15px] text-[#475569] leading-relaxed">
                          {role.tagline}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="inline-flex items-center text-xs font-medium px-3 py-1 rounded-full bg-[#F1F5F9] text-[#475569]">
                          {role.location}
                        </span>
                        <span className="text-sm font-medium text-settle-blue-600 group-hover:translate-x-0.5 transition-transform">
                          View role →
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <Footer />
    </>
  )
}
