'use client'

import { useState } from 'react'
import Header from '@/components/Header'
import { SignUpModal, ContactModal } from '@/components/Modal'
import Hero from '@/components/sections/Hero'
import HowItWorks from '@/components/sections/HowItWorks'
import Differentiation from '@/components/sections/Differentiation'
import Credibility from '@/components/sections/Credibility'
import FAQ from '@/components/sections/FAQ'
import FinalCTA from '@/components/sections/FinalCTA'
import Footer from '@/components/Footer'

export default function LandingPageClient() {
  return (
    <div className="min-h-screen bg-white">
      <Header />
      
      <main>
        <Hero />
        <HowItWorks />
        <Credibility />
        <Differentiation />
        <FAQ />
        <FinalCTA />
      </main>

      <Footer />
    </div>
  )
}
