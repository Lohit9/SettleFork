'use client'

import { useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'

const NAV_LINKS = [
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Migrations',   href: '/migrate' },
  { label: 'Pricing',      href: '/pricing' },
]

const CALENDLY = 'https://calendly.com/settle-ai/demo'

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false)

  const closeMenu = () => setMobileOpen(false)

  return (
    <motion.header
      className="sticky top-0 z-50 bg-white/85 backdrop-blur-xl border-b border-[color:var(--line)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <div className="flex justify-between items-center h-16">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5" onClick={closeMenu}>
            <img
              src="/images/logos/settle-logo-full.svg"
              alt="Settle"
              className="h-7 w-auto"
            />
          </Link>

          {/* Desktop nav */}
          <div className="hidden lg:flex items-center gap-6">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-[color:var(--ink-2)] hover:text-[color:var(--ink)] transition-colors"
              >
                {link.label}
              </Link>
            ))}

            <Link
              href="/login"
              className="text-sm font-medium text-[color:var(--ink-2)] hover:text-[color:var(--ink)] transition-colors"
            >
              Sign in
            </Link>

            <a
              href={CALENDLY}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Book a demo
            </a>
          </div>

          {/* Mobile hamburger */}
          <button
            className="lg:hidden flex flex-col justify-center gap-1.5 w-8 h-8 p-1"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            <span className={`block h-0.5 bg-[color:var(--ink-2)] transition-all duration-300 ${mobileOpen ? 'rotate-45 translate-y-2' : ''}`} />
            <span className={`block h-0.5 bg-[color:var(--ink-2)] transition-all duration-300 ${mobileOpen ? 'opacity-0' : ''}`} />
            <span className={`block h-0.5 bg-[color:var(--ink-2)] transition-all duration-300 ${mobileOpen ? '-rotate-45 -translate-y-2' : ''}`} />
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: 'hidden' }}
            className="lg:hidden border-t border-[color:var(--line)] bg-white/95 backdrop-blur-xl"
          >
            <div className="px-6 py-5 flex flex-col gap-4">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={closeMenu}
                  className="text-sm font-medium text-[color:var(--ink-2)] hover:text-[color:var(--ink)] transition-colors py-1"
                >
                  {link.label}
                </Link>
              ))}
              <div className="pt-2 flex flex-col gap-3">
                <a
                  href={CALENDLY}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={closeMenu}
                  className="w-full btn btn-primary"
                >
                  Book a demo
                </a>
                <Link
                  href="/login"
                  onClick={closeMenu}
                  className="text-sm font-medium text-[color:var(--ink-2)] hover:text-[color:var(--ink)] transition-colors text-center py-1"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  )
}
