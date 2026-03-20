'use client'

import { useState } from 'react'
import Header from '@/components/Header'
import { SignUpModal, ContactModal } from '@/components/Modal'
import Hero from '@/components/sections/Hero'
import ProblemSolution from '@/components/sections/ProblemSolution'
import MetricsBar from '@/components/sections/MetricsBar'
import HowItWorks from '@/components/sections/HowItWorks'
import Differentiation from '@/components/sections/Differentiation'
import Vision from '@/components/sections/Vision'
import Credibility from '@/components/sections/Credibility'
import FAQ from '@/components/sections/FAQ'
import FinalCTA from '@/components/sections/FinalCTA'
import Footer from '@/components/Footer'

export default function Home() {
  const handleHowItWorksClick = () => {
    const element = document.getElementById('how')
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <Header />
      
      <main>
        <Hero />
        <ProblemSolution onHowItWorksClick={handleHowItWorksClick} />
        <MetricsBar />
        <HowItWorks />
        <Differentiation />
        <Vision />
        <Credibility />
        <FAQ />
        <FinalCTA />
      </main>

      <Footer />
    </div>
  )
}

