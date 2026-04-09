'use client'

import Link from 'next/link'

export default function MidPageCTA() {
  return (
    <section className="py-16 bg-white border-t border-[#E2E8F0]">
      <div className="max-w-4xl mx-auto px-6 flex flex-col items-center text-center gap-4">
        <p className="text-sm font-semibold tracking-widest text-[#3B82F6] uppercase">
          Ready to see this on your data?
        </p>
        <h2 className="text-2xl font-semibold text-[#0F172A] tracking-tight">
          Upload your schema. Settle maps it in minutes.
        </h2>
        <p className="text-[#64748B] text-base leading-relaxed max-w-xl">
          Tell us about your migration and we'll share a preliminary assessment 
          within 48 hours — at no cost.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link
            href="/request-access"
            className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-[#2358D4] text-white text-sm font-semibold hover:bg-[#1D4ED8] transition-colors"
          >
            Request Access
          </Link>
          <Link
            href="https://calendly.com/settle-ai/demo"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center px-6 py-3 rounded-lg border border-[#E2E8F0] text-[#0F172A] text-sm font-semibold hover:bg-[#F8FAFC] transition-colors"
          >
            Book a Demo
          </Link>
        </div>
      </div>
    </section>
  )
}
