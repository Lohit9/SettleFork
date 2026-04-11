'use client'

import { useEffect, useRef, useState } from 'react'
import { useInView } from 'framer-motion'

interface AnimatedCounterProps {
  end: number
  suffix?: string
  prefix?: string
  duration?: number
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export function AnimatedCounter({ end, suffix = '', prefix = '', duration = 2000 }: AnimatedCounterProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-60px' })
  // Initialize to `end` so SSR/first paint renders the correct final value.
  // The animation will reset to 0 and count up after hydration + viewport entry.
  const [count, setCount] = useState(end)
  const hasAnimated = useRef(false)

  useEffect(() => {
    if (!isInView || hasAnimated.current) return
    hasAnimated.current = true

    // Reset to 0 immediately before the animation begins so the count-up
    // plays from zero visually, while the SSR HTML already held the final value.
    setCount(0)

    const startTime = performance.now()

    function tick(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = easeOutCubic(progress)

      setCount(Math.round(eased * end))

      if (progress < 1) {
        requestAnimationFrame(tick)
      }
    }

    requestAnimationFrame(tick)
  }, [isInView, end, duration])

  return (
    <span ref={ref}>
      {prefix}{count.toLocaleString('en-US')}{suffix}
    </span>
  )
}

export default AnimatedCounter
