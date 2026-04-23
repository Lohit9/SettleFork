import { createHash } from 'crypto'

/**
 * SHA-256 hash of a lowercased email, truncated to 16 hex
 * characters (64 bits entropy). Use for audit metadata when
 * the user is unauthenticated — never store raw PII for
 * anonymous failed attempts.
 *
 * Pure synchronous function (no 'use server' — lives in
 * lib/sso/ utility folder). Safe to import from server
 * actions, route handlers, or any other server-side code.
 */
export function hashEmail(email: string): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16)
}
