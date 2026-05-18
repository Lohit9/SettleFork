/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV !== 'production'
const connectSrc = [
  "'self'",
  'https://*.supabase.co',
  'https://api.anthropic.com',
]

if (isDev) {
  connectSrc.push(
    'http://127.0.0.1:54321',
    'http://127.0.0.1:55421',
    'http://localhost:54321',
    'http://localhost:55421',
  )
}

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://challenges.cloudflare.com https://vercel.live",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co",
      `connect-src ${connectSrc.join(' ')}`,
      "font-src 'self'",
      "frame-src 'self' https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
    ].join('; '),
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
]

const nextConfig = {
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/figma/**', '**/node_modules/**'],
    }

    return config
  },
}

module.exports = nextConfig
