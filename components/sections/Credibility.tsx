import ScrollReveal from '@/components/ui/ScrollReveal'

export default function Credibility() {
  return (
    <section className="bg-[#F8FAFC] py-12 px-6 lg:px-12">
      <div className="max-w-3xl mx-auto text-center">
        <ScrollReveal>
          <p className="text-[15px] text-[#475569] leading-relaxed">
            <span className="font-semibold text-[#0F172A]">
              Built by migration specialists, not general-purpose AI.
            </span>{' '}
            Founded by a former Deloitte data migration lead who&apos;s run the programs Mine is built to automate. In active design partnership with enterprise clients.
          </p>
        </ScrollReveal>
      </div>
    </section>
  )
}
