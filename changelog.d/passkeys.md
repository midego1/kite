### Added

- Sign in with a passkey: your fingerprint, face, device PIN or a security key instead of your password. A passkey also counts as your second step, so no authenticator code is asked for. It needs a database update from the Admin overview; see [Passkeys](https://github.com/midego1/kite/blob/main/docs/passkeys.md).
  ![The sign-in page with a Sign in with a passkey button under the password form](/changelog/2026-11-10-passkey-sign-in-light.webp)
  ![The same sign-in page on a phone](/changelog/2026-11-10-passkey-sign-in-mobile-light.webp)
- [Settings → Security](/settings/security) lists your passkeys with when they were added and last used. Adding or removing one asks for your password again, or a code from your authenticator app when two-factor is on.
  ![Settings → Security with one passkey, when it was added and last used, and Add a passkey](/changelog/2026-11-10-passkeys-security-light.webp)
  ![The passkeys on a phone](/changelog/2026-11-10-passkeys-security-mobile-light.webp)
- Kite emails you when a passkey is added to or removed from your account, and resetting your password with a reset link removes your passkeys.
- Administrators can reset an account's two-factor sign-in and passkeys for someone who lost their devices, after confirming with their own password or authenticator code.
