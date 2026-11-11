# Passkeys (WebAuthn) for sign-in

Status: built (November 2026, migration 0112). User docs: [Passkeys](../passkeys.md).

## Goals

- Users register passkeys in Settings → Security (name, created, last used, remove) and sign in with them: discoverable credentials offered as autofill on the email field (conditional mediation) and a **Sign in with a passkey** button.
- A passkey sign-in satisfies two-factor authentication: user verification is required on every ceremony, so no TOTP code is asked for afterwards.
- No dependency: WebAuthn verification on Web Crypto, identical on Workers and the Node runtime.

## Relying party

`relyingParty(env.APP_URL, request.url)` (`src/lib/auth/passkey-utils.ts`): the origin and host name of `APP_URL` when it is set and valid, otherwise the request's own. The RP ID is the host name (no port), the expected origin is exact (scheme, host and port). Changing `APP_URL` to another host makes existing passkeys unusable there, as it would in any WebAuthn deployment.

## Ceremonies

| Step | Route | Guard |
| --- | --- | --- |
| Registration options | `POST /api/settings/passkeys/options` with `{ password }` or `{ code }` | session, `hasValidSessionMutationOrigin`, login rate limit, re-authentication |
| Registration | `POST /api/settings/passkeys` with `{ ceremonyId, name, credential }` | session, same origin, passkey rate limit, challenge bound to user and session |
| List | `GET /api/settings/passkeys` | session |
| Remove | `DELETE /api/settings/passkeys/[id]` with `{ password }` or `{ code }` | session, same origin, login rate limit, re-authentication |
| Sign-in options | `POST /api/auth/passkey/options` | passkey rate limit; sets the httpOnly `kite_passkey_ceremony` cookie |
| Sign-in | `POST /api/auth/passkey/verify` with `{ credential }` | passkey rate limit, same origin, the ceremony cookie |
| Admin reset | `DELETE /api/accounts/[id]/mfa` | account admin rules of `PATCH /api/accounts/[id]`, same origin |

- **Challenges** (`passkey_challenges`, `src/lib/auth/passkey-challenges.ts`): 32 random bytes, stored with the SHA-256 of a separate ceremony token, five minutes plus 30 seconds. `consumePasskeyChallenge` deletes the row with `RETURNING` before checking it, so a challenge is answered at most once even under a race, and a mismatched purpose, user or session still uses it up. Expired rows are deleted whenever a new ceremony starts.
- **Binding**: a registration challenge records the user and the hash of the session token that asked for it; sign-in challenges are tied to the browser by the ceremony cookie (`SameSite=Strict`, path `/api/auth/passkey`).
- **Re-authentication**: adding or removing a passkey needs the password, or a current TOTP code when TOTP is on (`verifyReauthentication`, `src/lib/auth/reauth.ts`). Recovery codes are not accepted there, so re-authentication never uses one up. The registration challenge is the proof that the re-authentication was recent.
- **Options**: `residentKey: "required"`, `userVerification: "required"`, `attestation: "none"`, algorithms ES256 (-7), EdDSA (-8) and RS256 (-257), `excludeCredentials` with the user's passkeys, and an empty `allowCredentials` for sign-in. The user handle is the bytes of the user id, never an address.

## Verification (`src/lib/auth/webauthn/`)

- `cbor-utils.ts`: a CBOR decoder for definite-length integers, byte and text strings, arrays, maps and simple values; it refuses tags, floats, indefinite lengths, duplicate map keys, integers past 2^53 and nesting beyond 16.
- `cose-utils.ts`: COSE keys to JWK and Web Crypto keys (EC2 P-256, RSA of at least 2048 bits, OKP Ed25519); DER ECDSA signatures to `r || s`.
- `verify-utils.ts`: registration (§7.1) and assertion (§7.2). Both check the client data type, challenge (constant time), exact origin and `crossOrigin`, the RP ID hash, user presence and user verification, and the backup flags. Registration takes the credential and COSE key from the authenticator data and proves Web Crypto can import the key; a `none` statement must be empty and other formats are treated as `none`, since attestation is not used. Assertions verify the signature over `authenticatorData || SHA-256(clientDataJSON)`, and the stored user handle must match the one returned.
- **Signature counter**: when both the stored and the new counter are 0 (synced passkeys) the assertion is accepted; otherwise the new counter must be greater, and a counter that did not grow is refused as a possible cloned authenticator (`counter_regression`). The update only moves the counter forward.

## Data

`passkeys` (credential id, COSE public key, algorithm, counter, transports, AAGUID, backup flags, name, created, last used), cascading on the user. It is in the `accounts` backup group: public keys only. `passkey_challenges` is internal and never backed up.

Before migration 0112, reads answer `available: false`, ceremonies answer 503 `MIGRATION_PENDING`, the login page's autofill stays quiet and the password sign-in is unchanged; an admin reset still clears TOTP and recovery codes.

## Audit

`auth.passkey_added`, `auth.passkey_removed` (with the passkey's name) and `auth.mfa_reset` (actor is the admin) are listed in Admin → Activity. A passkey sign-in records `auth.login` with `method: "passkey"` and `auth.passkey_verified`.

## Tests

- `tests/passkeys.test.mjs`: real ES256, RS256 and EdDSA registrations (attestation `none`) and assertions captured from Chromium's virtual authenticator (`tests/fixtures/webauthn/`), wrong origin, RP ID, challenge and type, missing UV and UP flags, counter regression and the 0/0 case, tampered signatures, the CBOR, COSE and DER parsers, challenge replay and binding, the full ceremony against SQLite, the admin reset, the pre-migration fallback and backup coverage.
- `e2e/107-passkeys.spec.ts`: with the CDP virtual authenticator, register, sign out, sign in with the passkey while TOTP is on (no code asked), remove with re-authentication, a removed passkey refused, and the admin reset.

## Not done

- Renaming a passkey, and re-authenticating with a passkey instead of the password.
- Passkey-only accounts (every account keeps its password).
