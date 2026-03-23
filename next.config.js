/** @type {import('next').NextConfig} */

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
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co",
      "connect-src 'self' https://*.supabase.co https://api.anthropic.com",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
]

const nextConfig = {
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', '@napi-rs/canvas'],
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
  webpack: (config, { isServer }) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/figma/**', '**/node_modules/**'],
    }

    // Handle native Node.js addons (.node binaries) — used by @napi-rs/canvas
    // which is a transitive dep of pdf-parse. Without this, webpack tries to
    // parse the binary and fails with "Unexpected character" errors.
    config.module.rules.push({
      test: /\.node$/,
      use: 'node-loader',
    })

    // Prevent webpack from bundling pdf-parse, pdfjs-dist, and @napi-rs/canvas.
    // serverExternalPackages covers the top-level package names, but webpack still
    // traverses sub-paths and platform-specific packages. The externals function
    // catches all of them by prefix-matching the import request string.
    if (isServer) {
      config.externals.push(({ request }, callback) => {
        if (
          /^pdf-parse/.test(request) ||
          /^pdfjs-dist/.test(request) ||
          /@napi-rs\/canvas/.test(request)
        ) {
          return callback(null, `commonjs ${request}`)
        }
        callback()
      })
    }

    return config
  },
}

module.exports = nextConfig
