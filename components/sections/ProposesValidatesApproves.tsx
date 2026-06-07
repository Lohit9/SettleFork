type Variant = 'blue' | 'neutral' | 'green'

const CHIP: Record<Variant, { bg: string; color: string; dot: string }> = {
  blue: { bg: 'var(--blue-tint)', color: 'var(--blue-press)', dot: 'var(--blue)' },
  neutral: { bg: 'var(--surface-2)', color: 'var(--ink)', dot: 'var(--ink)' },
  green: { bg: 'var(--green-tint)', color: 'var(--green-deep)', dot: 'var(--green)' },
}

const CARDS: { num: string; chip: string; variant: Variant; h3: string; body: string; highlight?: boolean }[] = [
  {
    num: '01',
    chip: 'AI proposes',
    variant: 'blue',
    h3: 'It suggests — it never writes',
    body: "Settle's models read both schemas and propose every field mapping, transform, and edge-case rule, each with a confidence score. Proposals are explainable and fully editable. The model has no path to your production target.",
  },
  {
    num: '02',
    chip: 'Engines validate',
    variant: 'neutral',
    h3: 'Deterministic, reproducible checks',
    body: 'Rule engines — not the model — validate every row against your constraints, types, referential integrity, and business logic. Same input, same result, every time. The validation report is auditable end to end.',
  },
  {
    num: '03',
    chip: 'Humans approve',
    variant: 'green',
    h3: 'The decision stays with you',
    body: "Nothing migrates until your team reviews what's flagged and approves the load package. Every proposal, override, and sign-off is versioned and logged — so the trail is yours to defend.",
    highlight: true,
  },
]

export default function ProposesValidatesApproves() {
  return (
    <section className="section border-y border-[color:var(--line)] bg-[color:var(--surface)]">
      <div className="wrap">
        <div className="sec-head mx-auto max-w-[720px] text-center">
          <div className="kicker">How we guarantee our results</div>
          <h2 className="h2 mt-[14px]">AI proposes. Engines validate. You approve.</h2>
          <p className="mt-4 text-[18px] leading-[1.55] text-[color:var(--ink-2)]">
            The intelligence and the verification are deliberately separated. The model suggests; it never
            decides what reaches your production systems.
          </p>
        </div>

        <div className="mt-14 grid items-stretch gap-7 md:grid-cols-3">
          {CARDS.map((card) => {
            const chip = CHIP[card.variant]
            return (
              <div
                key={card.num}
                className="rounded-[16px] border"
                style={{
                  padding: '36px 32px',
                  background: card.highlight ? 'rgba(29,158,117,.06)' : 'var(--surface-2)',
                  borderColor: card.highlight ? 'rgba(29,158,117,.24)' : 'var(--line)',
                }}
              >
                <div className="mono text-[15px] font-bold tracking-[0.02em] text-[color:var(--ink-2)]">
                  {card.num}
                </div>
                <div
                  className="mono inline-flex items-center gap-[9px] rounded-[8px] px-[13px] py-[7px] text-[13px] font-semibold uppercase tracking-[0.04em]"
                  style={{ margin: '20px 0 18px', background: chip.bg, color: chip.color }}
                >
                  <span className="h-2 w-2 rotate-45 rounded-[2px]" style={{ background: chip.dot }} />
                  {card.chip}
                </div>
                <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-[color:var(--ink)]">
                  {card.h3}
                </h3>
                <p className="mt-[14px] text-[14.5px] leading-[1.6] text-[color:var(--ink-2)]">{card.body}</p>
              </div>
            )
          })}
        </div>

        <div className="mono mt-7 text-center text-[14px] text-[color:var(--ink-2)]">
          No black box. Every proposal is <b className="text-[color:var(--ink)]">explainable</b>, every check
          is <b className="text-[color:var(--ink)]">reproducible</b>, every approval is{' '}
          <b className="text-[color:var(--ink)]">logged</b>.
        </div>
      </div>
    </section>
  )
}
