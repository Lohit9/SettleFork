'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/app/PageHeader'

// ── Types ──────────────────────────────────────────────────────────────────────

export type GenerationPhase = 'profile' | 'map' | 'transform' | 'validate' | 'done'

export interface GeneratingContentProps {
  projectId: string
  projectName: string
  // Backend integration surface: pass live data from a streaming endpoint or polling hook.
  // Defaults are demo values so the page renders correctly before wiring up real data.
  currentPhase?: GenerationPhase
  currentStepLabel?: string
  feedLines?: string[]
  progressText?: string
  onComplete?: (projectId: string) => void
}

// ── Phase tracker ──────────────────────────────────────────────────────────────

const PHASES: { key: GenerationPhase; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'map', label: 'Map' },
  { key: 'transform', label: 'Transform' },
  { key: 'validate', label: 'Validate' },
]

const PHASE_ORDER: GenerationPhase[] = ['profile', 'map', 'transform', 'validate', 'done']

function phaseStatus(key: GenerationPhase, current: GenerationPhase): 'done' | 'active' | 'pending' {
  const ki = PHASE_ORDER.indexOf(key)
  const ci = PHASE_ORDER.indexOf(current)
  if (ki < ci) return 'done'
  if (ki === ci) return 'active'
  return 'pending'
}

function CheckIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function LoadingBarsIcon({ className = '' }: { className?: string }) {
  return (
    <span className={`mini-bars-loader ${className}`} role="presentation" aria-hidden="true">
      <span className="bar bar-1" />
      <span className="bar bar-2" />
      <span className="bar bar-3" />
    </span>
  )
}

// Profile (done) · Map (active) · Transform · Validate — horizontal tracker that
// mirrors generation.html: 22px nodes, green completed, teal pulsing active node.
function PhaseTracker({ current }: { current: GenerationPhase }) {
  return (
    <div className="mt-12 w-full max-w-[440px]" aria-label="Progress">
      <div className="flex items-center justify-between">
        {PHASES.map((phase, idx) => {
          const status = phaseStatus(phase.key, current)
          const isLast = idx === PHASES.length - 1
          return (
            <Fragment key={phase.key}>
              <div className="flex flex-col items-center gap-2 shrink-0" style={{ width: 84 }}>
                <div
                  className={`w-[22px] h-[22px] rounded-full flex items-center justify-center ${
                    status === 'active'
                      ? 'border-2 phase-pulse-active'
                      : status === 'pending'
                      ? 'border-2 border-[#E7E7EA]'
                      : ''
                  }`}
                  style={
                    status === 'done'
                      ? { background: '#16a34a' }
                      : status === 'active'
                      ? { borderColor: '#1D9E75' }
                      : undefined
                  }
                >
                  {status === 'done' ? (
                    <CheckIcon />
                  ) : status === 'active' ? (
                    <span className="w-[8px] h-[8px] rounded-full" style={{ background: '#1D9E75' }} />
                  ) : (
                    <span className="w-[7px] h-[7px] rounded-full bg-[#D1D5DB]" />
                  )}
                </div>
                <span
                  className={`text-[12.5px] ${
                    status === 'done'
                      ? 'font-medium text-[#16a34a]'
                      : status === 'active'
                      ? 'font-semibold'
                      : 'font-medium text-[#9CA3AF]'
                  }`}
                  style={status === 'active' ? { color: '#1D9E75' } : undefined}
                >
                  {phase.label}
                </span>
              </div>
              {!isLast && (
                <div
                  className="flex-1 h-px -mt-5 mx-1"
                  style={{ background: status === 'done' ? 'rgba(22, 163, 74, 0.35)' : '#E7E7EA' }}
                />
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

// ── Reasoning feed (centered, oldest → newest, lightest → darkest) ─────────────

const FEED_COLORS = ['#D1D5DB', '#9CA3AF', '#6B7280']

function ReasoningFeed({ lines }: { lines: string[] }) {
  const shown = lines.slice(-3)
  const padded = [...Array(Math.max(0, 3 - shown.length)).fill(''), ...shown]
  return (
    <div className="mt-4 flex flex-col items-center gap-1.5" aria-live="polite" aria-atomic="false">
      {padded.map((line, i) => (
        <div
          key={`${i}-${line}`}
          className={`text-[14px] leading-relaxed ${i === 2 && line ? 'feed-line' : ''}`}
          style={{ color: FEED_COLORS[i] }}
        >
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

// ── Demo cycling (remove when wiring real backend) ─────────────────────────────

const DEMO_STEPS: Array<{
  phase: GenerationPhase
  label: string
  progress: string
  feed: string[]
}> = [
  {
    phase: 'profile',
    label: 'Profiling schema',
    progress: 'Profiling 8 tables',
    feed: [
      'Reading table structures and column metadata',
      'Sampling value distributions across 24,500 rows',
      'Detecting primary keys and foreign key hints',
    ],
  },
  {
    phase: 'map',
    label: 'Mapping fields',
    progress: '118 of 140 fields mapped',
    feed: [
      'Analyzing source schema structure and field types',
      'Cross-referencing target schema constraints and nullability',
      'Inferring semantic relationships from field names',
    ],
  },
  {
    phase: 'transform',
    label: 'Generating transforms',
    progress: 'Writing transforms for 18 mapped fields',
    feed: [
      'ACCT_TYPE_CD → account_type_id: enum normalisation',
      'STATUS → status_code: A/D/C → active/dormant/closed',
      'Generating CASE expressions for 6 conditional mappings',
    ],
  },
  {
    phase: 'validate',
    label: 'Validating output',
    progress: 'Checking 112 field mappings',
    feed: [
      'Running NOT NULL constraint checks on required fields',
      'Verifying referential integrity for foreign keys',
      'Confirming row counts match within tolerance',
    ],
  },
]

// ── Main component ─────────────────────────────────────────────────────────────

export function GeneratingContent({
  projectId,
  projectName,
  currentPhase: controlledPhase,
  currentStepLabel: controlledLabel,
  feedLines: controlledFeed,
  progressText: controlledProgress,
  onComplete,
}: GeneratingContentProps) {
  const router = useRouter()

  // If no controlled props provided, cycle through demo steps.
  // When backend integration is added: replace this block with real data from a
  // streaming endpoint (SSE / WebSocket) or a polling SWR hook.
  const [demoIdx, setDemoIdx] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Advance through the phases once, then settle on 'done'. No wrap — the demo is
  // a one-way progression so it actually completes and hands off to the mapping view.
  useEffect(() => {
    if (controlledPhase) return // controlled — no demo cycling
    if (demoIdx >= DEMO_STEPS.length) return // reached 'done' — stop cycling
    timerRef.current = setTimeout(() => {
      setDemoIdx((i) => i + 1)
    }, 3000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [demoIdx, controlledPhase])

  // Past the last step, keep the final step's copy on screen but report phase
  // 'done' so the navigation effect below advances to the mapping view.
  const demoDone = demoIdx >= DEMO_STEPS.length
  const demo = DEMO_STEPS[demoIdx] ?? DEMO_STEPS[DEMO_STEPS.length - 1]
  const phase = controlledPhase ?? (demoDone ? 'done' : demo.phase)
  const stepLabel = controlledLabel ?? demo.label
  const feed = controlledFeed ?? demo.feed
  const progress = controlledProgress ?? demo.progress

  // Backend integration point: when onComplete is called (or phase === 'done'),
  // navigate to the mapping view. Replace the router.push target as needed.
  useEffect(() => {
    if (phase === 'done') {
      if (onComplete) {
        onComplete(projectId)
      } else {
        router.push(`/app/projects/${projectId}/mapping`)
      }
    }
  }, [phase, projectId, onComplete, router])

  return (
    <div className="min-h-full flex flex-col bg-[#FAFAFA]">
      <PageHeader projectName={projectName} title="Configure" projectId={projectId} />

      {/* Calm, near-blank canvas with one centered progress block */}
      <main className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-[560px] px-8 flex flex-col items-center text-center">

          {/* Refresh-in-place status region: current step → reasoning feed → progress */}
          <div className="w-full flex flex-col items-center">
            <div className="flex items-center justify-center gap-2.5">
              <LoadingBarsIcon />
              <span className="text-[20px] font-medium text-[#111827] tracking-[-0.01em]">{stepLabel}</span>
              <span className="caret-blink text-[20px] font-medium leading-none -ml-0.5">▍</span>
            </div>

            <ReasoningFeed lines={feed} />

            <div className="mt-5 text-[13px] text-[#9CA3AF] tabular-nums">{progress}</div>
          </div>

          <PhaseTracker current={phase} />

        </div>
      </main>
    </div>
  )
}
