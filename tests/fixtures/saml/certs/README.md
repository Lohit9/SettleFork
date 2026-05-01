# SAML signing-cert test fixtures

## What these fixtures test

Each `.pem` in this directory is a self-signed X.509 certificate fed
into `validateSigningCert` from `lib/sso/cert-validation.ts`. The
tests in `tests/lib/sso/cert-validation.test.ts` load them as static
bytes, then assert each one produces the expected validation outcome
— signature-algorithm OID, key strength, validity window, and
SHA-256 fingerprint behavior.

These are **not** real certificates. They have no private-key
material exposed (private keys are written to `/tmp` during
generation and immediately discarded), no association with any
production identity provider, and several are deliberately
weak/expired to exercise rejection paths. Subject CNs all begin
with `Settle SAML Test` so secret scanners can pattern-match-exclude
them.

## Files in this directory

| File | Purpose |
|---|---|
| `valid-sha256-rsa-2048.pem` | Acceptance: SHA-256 RSA-2048 (the modern baseline) |
| `valid-sha384-rsa-3072.pem` | Acceptance: SHA-384 RSA-3072 (also drives the fingerprint-inequality assertion) |
| `valid-ecdsa-p256.pem` | Acceptance: ECDSA on prime256v1 |
| `valid-ed25519.pem` | Acceptance: Ed25519 |
| `sha1-rsa-2048.pem` | Rejection: deprecated signature alg (`CERT_WEAK_SIGNATURE_ALG`) |
| `md5-rsa-2048.pem` | Rejection: deprecated signature alg (`CERT_WEAK_SIGNATURE_ALG`); needs OpenSSL legacy provider to generate |
| `weak-rsa-1024.pem` | Rejection: undersized RSA key (`CERT_WEAK_KEY`) |
| `weak-ec-p192.pem` | Rejection: undersized EC curve (`CERT_WEAK_KEY`) |
| `expired-rsa-2048.pem` | Rejection: `notAfter` in the past (`CERT_EXPIRED`); fixture's `notAfter` is `2020-01-02` |
| `not-yet-valid-rsa-2048.pem` | Rejection: `notBefore` in the future (`CERT_NOT_YET_VALID`); fixture's `notBefore` is `2099-01-01` |

## How to regenerate

```
./scripts/generate-saml-test-certs.sh
```

The script is idempotent — re-running overwrites every PEM in this
directory from scratch. You'll get a fresh keypair (and therefore a
fresh SHA-256 fingerprint) on each run, but the validation outcome
each test asserts is determined by the cert's structural properties
(algorithm OID, key size, validity dates), not by any specific
fingerprint value, so re-runs do not require updating the test code.

Requires OpenSSL 3.x with the legacy provider available (default on
recent macOS/Linux installs). The MD5 cert specifically needs
`-provider legacy`; without it the script's `md5-rsa-2048.pem` step
fails. The `weak-ec-p192.pem` step is conditional — if your local
OpenSSL refuses secp192r1 generation, the script logs a skip and
that one test will fail with `ENOENT` until you regenerate on a
build that supports the curve.

## Why these are committed despite `*.pem` in `.gitignore`

The repo-level `.gitignore` has a global `*.pem` rule (line 20) that
would otherwise swallow these fixtures silently — `git add` skips
them without warning, the commit ships without them, and CI breaks
with `ENOENT` once the test loader runs. This bit us once already
(see the `chore(test): commit SAML cert fixtures` history entry).

The negation rule directly below `*.pem`:

```
!tests/fixtures/saml/certs/*.pem
```

scopes the exception to this directory only. **Do not remove it.**
If you regenerate these fixtures and `git add` says nothing, the
negation rule has been deleted or reordered — restore it before
committing.

## Determinism contract

The tests assert _structural_ properties (algorithm OID, key size,
key type, key curve, fingerprint stability across calls on the same
bytes, fingerprint inequality between distinct certs). They do
**not** pin specific fingerprint hex values, subject DN strings
beyond the CN substring check, or specific serial numbers.

This means a contributor regenerating fixtures does not need to
update any test assertions — the new certs will have new
fingerprints, but the test will assert the new fingerprint equals
itself, which is the actual security property under test.

The two date-bound fixtures (`expired-rsa-2048.pem`,
`not-yet-valid-rsa-2048.pem`) are pinned to specific years (2020
and 2099 respectively) by `-not_before` / `-not_after` flags in the
generation script — those tests assert on the year substring of
the error message and would fail if the script's hardcoded dates
change.

## Validity windows

The four `valid-*.pem` fixtures are generated with `-days 3650`
(10 years). Generated 2026-05-01, they expire 2036-04-29. When
that approaches, regenerate via the script — the tests'
`new Date(r.not_after).getTime() > Date.now()` assertion is the
forcing function and will start failing well before the certs
themselves matter to anything.
