import Link from 'next/link'
import ScrollReveal from '@/components/ui/ScrollReveal'

export default function FinalCTA() {
  return (
    <section className="bg-[#0F172A] py-24 px-6 lg:px-12">
      <div className="max-w-xl mx-auto text-center">
        <ScrollReveal>
          <h2 className="text-4xl font-bold text-white tracking-tight mb-4">
            Consider it settled.
          </h2>
          <p className="text-[#94A3B8] text-base leading-relaxed mb-9">
            Tell us about your upcoming migration. We&apos;ll share a preliminary assessment within 48 hours — at no cost.
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/request-access"
              className="bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-4 rounded-xl text-base shadow-lg shadow-blue-600/25 hover:-translate-y-0.5 transition-all"
            >
              Request Access
            </Link>
            <a
              href="https://calendly.com/settle-ai/demo"
              target="_blank"
              rel="noopener noreferrer"
              className="border border-[#334155] text-[#CBD5E1] font-medium px-8 py-4 rounded-xl text-base hover:border-[#64748B] hover:text-white transition-all"
            >
              Book a Demo
            </a>
          </div>
        </ScrollReveal>
      </div>
    </section>
  )
}
