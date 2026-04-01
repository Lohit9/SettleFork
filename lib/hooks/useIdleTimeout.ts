'use client'

import { useEffect, useCallback, useRef } from 'react'

const IDLE_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'] as const

export function useIdleTimeout(onTimeout: () => void, timeoutMs: number = 30 * 60 * 1000) {
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(onTimeout, timeoutMs)
  }, [onTimeout, timeoutMs])

  useEffect(() => {
    resetTimer()

    for (const event of IDLE_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true })
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      for (const event of IDLE_EVENTS) {
        window.removeEventListener(event, resetTimer)
      }
    }
  }, [resetTimer])
}
