import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Every test gets a clean DOM. Prevents cross-test leakage in jsdom.
afterEach(() => {
  cleanup()
})
