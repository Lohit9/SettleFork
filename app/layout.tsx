import type { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' })

export const metadata: Metadata = {
  title: 'Settle — AI-Native Data Migration Platform',
  description:
    'Settle automates enterprise data migrations — AI maps fields, generates SQL, validates data quality, and delivers production-ready load files. 40–50% cost reduction. 3,412 fields auto-mapped per project.',
  viewport: 'width=device-width, initial-scale=1',
  icons: {
    icon: '/images/logos/settle-logo-mark-dark.png',
    apple: '/images/logos/settle-logo-mark-dark.png',
  },
  openGraph: {
    title: 'Settle — AI-Native Data Migration Platform',
    description:
      'Automate enterprise data migrations. AI profiles schemas, maps fields, generates SQL, and validates data — delivering production-ready migration packages.',
    url: 'https://usesettle.ai',
    siteName: 'Settle',
    type: 'website',
    images: [
      {
        url: 'https://usesettle.ai/images/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Settle — AI-Native Data Migration Platform',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Settle — AI-Native Data Migration Platform',
    description:
      'Automate enterprise data migrations. AI profiles schemas, maps fields, generates SQL, and validates data — delivering production-ready migration packages.',
    images: ['https://usesettle.ai/images/og-image.png'],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`h-full ${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body className="h-full">{children}</body>
    </html>
  )
}

