#!/usr/bin/env bash
# Generate the static X.509 cert fixtures used by the SAML metadata
# test suite. Run once, commit the output PEMs into
# tests/fixtures/saml/certs/. The script is idempotent — re-running it
# regenerates from scratch — but the committed PEMs are what the tests
# load, so re-runs only matter when expanding the fixture set.
#
# Why pre-generate instead of build at test time:
#   - Node has no built-in X.509 *creation* API. crypto.X509Certificate
#     parses but does not sign new certs.
#   - Test runs are then offline + deterministic — no OpenSSL on CI.
#   - Deprecated algorithms (MD5, SHA-1) require OpenSSL legacy provider
#     flags, which are awkward to spawn from Node mid-test.
#
# Requires OpenSSL 3.x with the legacy provider available.
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/saml/certs"
mkdir -p "$OUT"
cd "$OUT"

# OpenSSL 3 needs the legacy provider for MD5 signing.
LEGACY="-provider default -provider legacy"

# ─── Valid: SHA-256 with RSA-2048, 10y validity ────────────────────────
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout /tmp/saml-test.key -out valid-sha256-rsa-2048.pem \
  -sha256 -subj "/CN=Settle SAML Test Valid SHA-256 RSA-2048/O=Settle Test/C=US"

# ─── Valid: SHA-384 with RSA-3072, 10y validity ────────────────────────
openssl req -x509 -nodes -newkey rsa:3072 -days 3650 \
  -keyout /tmp/saml-test.key -out valid-sha384-rsa-3072.pem \
  -sha384 -subj "/CN=Settle SAML Test Valid SHA-384 RSA-3072/O=Settle Test/C=US"

# ─── Valid: ECDSA P-256 (prime256v1) ────────────────────────────────────
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/saml-test-ec.key
openssl req -x509 -nodes -days 3650 \
  -key /tmp/saml-test-ec.key -out valid-ecdsa-p256.pem \
  -sha256 -subj "/CN=Settle SAML Test Valid ECDSA P-256/O=Settle Test/C=US"

# ─── Valid: Ed25519 ─────────────────────────────────────────────────────
openssl genpkey -algorithm Ed25519 -out /tmp/saml-test-ed25519.key
openssl req -x509 -nodes -days 3650 \
  -key /tmp/saml-test-ed25519.key -out valid-ed25519.pem \
  -subj "/CN=Settle SAML Test Valid Ed25519/O=Settle Test/C=US"

# ─── Deprecated: SHA-1 with RSA-2048 ───────────────────────────────────
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout /tmp/saml-test.key -out sha1-rsa-2048.pem \
  -sha1 -subj "/CN=Settle SAML Test Weak SHA-1 RSA-2048/O=Settle Test/C=US"

# ─── Deprecated: MD5 with RSA-2048 (requires legacy provider) ──────────
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout /tmp/saml-test.key -out md5-rsa-2048.pem \
  -md5 $LEGACY \
  -subj "/CN=Settle SAML Test Weak MD5 RSA-2048/O=Settle Test/C=US"

# ─── Weak key: RSA-1024 (with SHA-256, so the failure mode is key
#                         strength, not algorithm) ─────────────────────
openssl req -x509 -nodes -newkey rsa:1024 -days 3650 \
  -keyout /tmp/saml-test.key -out weak-rsa-1024.pem \
  -sha256 -subj "/CN=Settle SAML Test Weak RSA-1024/O=Settle Test/C=US"

# ─── Weak curve: EC secp192r1 (with SHA-256, so the failure mode is
#                               curve, not algorithm). Some OpenSSL
#                               builds deprecate this curve under the
#                               default provider. We try and fall back
#                               to a comment-only marker if the local
#                               OpenSSL refuses. ─────────────────────────
if openssl ecparam -name secp192r1 -genkey -noout -out /tmp/saml-test-ec192.key 2>/dev/null; then
  openssl req -x509 -nodes -days 3650 \
    -key /tmp/saml-test-ec192.key -out weak-ec-p192.pem \
    -sha256 -subj "/CN=Settle SAML Test Weak EC P-192/O=Settle Test/C=US"
else
  echo "(skipping weak-ec-p192.pem: OpenSSL refused secp192r1 — generated programmatically in tests instead)"
fi

# ─── Expired: notAfter in the past (1d back-dated, 1d validity) ────────
# OpenSSL's `-days` can take a negative value to force expiry. We use
# `-not_after` for explicit control — supported on OpenSSL 1.1.1+.
EXPIRED_NOT_BEFORE="20200101000000Z"
EXPIRED_NOT_AFTER="20200102000000Z"
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout /tmp/saml-test.key -out expired-rsa-2048.pem \
  -sha256 \
  -not_before "$EXPIRED_NOT_BEFORE" -not_after "$EXPIRED_NOT_AFTER" \
  -subj "/CN=Settle SAML Test Expired RSA-2048/O=Settle Test/C=US"

# ─── Not yet valid: notBefore far in the future ────────────────────────
# 2099 is comfortably beyond any test timeline.
FUTURE_NOT_BEFORE="20990101000000Z"
FUTURE_NOT_AFTER="20991231235959Z"
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout /tmp/saml-test.key -out not-yet-valid-rsa-2048.pem \
  -sha256 \
  -not_before "$FUTURE_NOT_BEFORE" -not_after "$FUTURE_NOT_AFTER" \
  -subj "/CN=Settle SAML Test Not Yet Valid RSA-2048/O=Settle Test/C=US"

rm -f /tmp/saml-test.key /tmp/saml-test-ec.key /tmp/saml-test-ed25519.key /tmp/saml-test-ec192.key

echo "Generated:"
ls -la "$OUT"
