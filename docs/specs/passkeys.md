# Passkeys (WebAuthn) for sign-in

Status: built (November 2026, migration 0112). User docs: [Passkeys](../passkeys.md).

## Goals

- Users register passkeys in Settings → Security (name, created, last used, remove) and sign in with them: discoverable credentials offered as autofill on the email field (conditional mediation) and a **Sign in with a passkey** button.
- A passkey sign-in satisfies two-factor authentication: user verification is required on every ceremony, so no TOTP code is asked for afterwards.
- No dependency: WebAuthn verification on Web Crypto, identical on Workers and the Node runtime.

## Relying party

`relyingParty(env.APP_URL, request.url)` (`src/lib/auth/passkey-utils.ts`): the origin and host name of `APP_URL` when it is set and valid, otherwise the request's own. Behind a proxy that terminates TLS (common for the Node runtime) the request's own origin is not the one the browser shows, so passkeys fail closed: **set `APP_URL` before people add passkeys**. Settings → Security shows admins a warning while `APP_URL` is missing, invalid, or plain http on a host other than localhost, where browsers refuse WebAuthn (`appUrlPasskeyWarning`). The RP ID is the host name (no port), the expected origin is exact (scheme, host and port). Changing `APP_URL` to another host makes existing passkeys unusable there, as it would in any WebAuthn deployment.

## Ceremonies

| Step | Route | Guard |
| --- | --- | --- |
| Registration options | `POST /api/settings/passkeys/options` with `{ password }` or `{ code }` | session, `hasValidSessionMutationOrigin`, login rate limit, re-authentication |
| Registration | `POST /api/settings/passkeys` with `{ ceremonyId, name, credential }` | session, same origin, passkey rate limit, challenge bound to user and session |
| List | `GET /api/settings/passkeys` | session |
| Remove | `DELETE /api/settings/passkeys/[id]` with `{ password }` or `{ code }` | session, same origin, login rate limit, re-authentication |
| Sign-in options | `POST /api/auth/passkey/options` | same origin, passkey rate limit; sets the httpOnly `kite_passkey_ceremony` cookie |
| Sign-in | `POST /api/auth/passkey/verify` with `{ credential }` | passkey rate limit, same origin, the ceremony cookie |
| Admin reset | `DELETE /api/accounts/[id]/mfa` with the admin's own `{ password }` or `{ code }` | account admin rules of `PATCH /api/accounts/[id]`, same origin, login rate limit, the admin's re-authentication |

- **Challenges** (`passkey_challenges`, `src/lib/auth/passkey-challenges.ts`): 32 random bytes, stored with the SHA-256 of a separate ceremony token, five minutes plus 30 seconds. `consumePasskeyChallenge` deletes the row with `RETURNING` before checking it, so a challenge is answered at most once even under a race, and a mismatched purpose, user or session still uses it up. Expired rows are deleted whenever a new ceremony starts.
- **Binding**: a registration challenge records the user and the hash of the session token that asked for it; sign-in challenges are tied to the browser by the ceremony cookie (`SameSite=Strict`, path `/api/auth/passkey`).
- **Re-authentication**: adding or removing a passkey needs the password, or a current TOTP code when TOTP is on (`verifyReauthentication`, `src/lib/auth/reauth.ts`). Recovery codes are not accepted there, so re-authentication never uses one up. A TOTP code is accepted once, across sign-in, enrolment, turning MFA off and re-authentication: its time step is stored in `totp_used_steps` with a conditional upsert (`claimTotpStep`, `src/lib/auth/totp-steps.ts`), and the same or an earlier step is refused (before migration 0112 a right code is accepted as before). The registration challenge is the proof that the re-authentication was recent.
- **Cap**: at most 20 passkeys per user, enforced by the insert itself (`INSERT … SELECT … WHERE (SELECT count(*) …) < 20`), so parallel registrations cannot pass it together; the unique credential id refuses the same passkey twice.
- **Notices**: adding or removing a passkey, and an admin reset, mail the account holder (`noticeSignInChange`, `src/lib/auth/sign-in-notice.ts`) through `sendSystemEmail`, to the recovery address when set; a failure is logged and never fails the change.
- **Password reset**: redeeming a reset link deletes the account's passkeys with its sessions, so a passkey added by someone who once had the password does not survive the reset. It is one batch (`redeemResetLink`): the link is claimed only while unused, by replacing its hash with a value unique to this redemption, and the password, session and passkey statements apply only if that claim is present, so a failure changes nothing and a racing second redemption changes nothing either.
- **Session at registration**: the passkey insert also requires the session that started the ceremony to still exist, so a reset that ends it while a registration is in flight is not followed by a new passkey.
- **Options**: `residentKey: "required"`, `userVerification: "required"`, `attestation: "none"`, algorithms ES256 (-7), EdDSA (-8) and RS256 (-257), `excludeCredentials` with the user's passkeys, and an empty `allowCredentials` for sign-in. The user handle is the bytes of the user id, never an address.

## Verification (`src/lib/auth/webauthn/`)

- `cbor-utils.ts`: a CBOR decoder for definite-length integers, byte and text strings, arrays, maps and simple values; it refuses tags, floats, indefinite lengths, duplicate map keys, integers past 2^53 and nesting beyond 16.
- `cose-utils.ts`: COSE keys to JWK and Web Crypto keys (EC2 P-256, RSA of at least 2048 bits with an odd public exponent of at least 3, OKP Ed25519); DER ECDSA signatures to `r || s`. High-S ECDSA signatures (and non-minimal DER integers) are accepted on purpose: some authenticators produce them, WebAuthn does not ask relying parties to refuse them, and the malleability they allow is harmless because every challenge is single-use.
- `verify-utils.ts`: registration (§7.1) and assertion (§7.2). Both check the client data type, challenge (constant time), exact origin and `crossOrigin`, the RP ID hash, user presence and user verification, and the backup flags. Registration takes the credential and COSE key from the authenticator data and proves Web Crypto can import the key; a `none` statement must be empty and other formats are treated as `none`, since attestation is not used. Assertions verify the signature over `authenticatorData || SHA-256(clientDataJSON)`, and the stored user handle must match the one returned.
- **Signature counter**: when both the stored and the new counter are 0 (synced passkeys) the assertion is accepted; otherwise the new counter must be greater, and a counter that did not grow is refused as a possible cloned authenticator (`counter_regression`). The update only moves the counter forward.

## Data

`passkeys` (credential id, COSE public key, algorithm, counter, transports, AAGUID, backup flags, name, created, last used), cascading on the user. It is in the `accounts` backup group: public keys only. `passkey_challenges` is internal and never backed up.

Before migration 0112, reads answer `available: false`, ceremonies answer 503 `MIGRATION_PENDING`, the login page's autofill stays quiet and the password sign-in is unchanged; an admin reset still clears TOTP and recovery codes.

## Audit

`auth.passkey_added`, `auth.passkey_removed` (with the passkey's name), `auth.mfa_reset` (actor is the admin) and `auth.password_reset` (with `passkeysRemoved`) are listed in Admin → Activity. A passkey sign-in records `auth.login` with `method: "passkey"` and `auth.passkey_verified`.

## Tests

- `tests/passkeys.test.mjs`: real ES256, RS256 and EdDSA registrations (attestation `none`) and assertions captured from Chromium's virtual authenticator (`tests/fixtures/webauthn/`), wrong origin, RP ID, challenge and type, missing UV and UP flags, counter regression and the 0/0 case, tampered signatures, the CBOR, COSE and DER parsers, challenge replay and binding, the full ceremony against SQLite, the admin reset, the pre-migration fallback and backup coverage.
- `e2e/107-passkeys.spec.ts`: with the CDP virtual authenticator, register, sign out, sign in with the passkey while TOTP is on (no code asked), remove with re-authentication, a removed passkey refused, and the admin reset.

## Not done

- Renaming a passkey, and re-authenticating with a passkey instead of the password.
- Passkey-only accounts (every account keeps its password).
