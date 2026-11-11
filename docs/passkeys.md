# Passkeys

A passkey lets you sign in to Kite with your fingerprint, your face, your device PIN or a security key instead of your password. It is stored on your phone or computer, in your password manager or on a security key, and only you can use it: Kite keeps the public half and never sees anything that could sign in for you.

A passkey counts as both steps of a sign-in. Your device always checks it is you (biometrics or a PIN) before it answers, so Kite does not ask for a code from your authenticator app after a passkey sign-in, even when two-factor authentication is on.

## Adding a passkey

1. Open [Settings → Security](/settings/security) and find **Passkeys**.
2. Click **Add a passkey**, give it a name if you like (for example "Work laptop"), and confirm your password. When two-factor authentication is on you can enter a code from your authenticator app instead.
3. Follow your browser's prompt. It saves the passkey on this device, in your password manager, or on a security key you plug in or tap.

You can add up to 20 passkeys, for example one per device. Passkeys saved in iCloud Keychain, Google Password Manager or a password manager are synced to your other devices and are marked **Synced** in the list.

## Signing in with a passkey

On the sign-in page, click the email field: your browser offers the passkeys it has for Kite next to your saved addresses. Pick one and confirm on your device. You can also click **Sign in with a passkey**, which opens the browser's own passkey dialog (useful for a phone or a security key).

Passkeys belong to the address you open Kite at. When an administrator sets the public address (`APP_URL`), passkeys are made for that address and only work there.

## Removing a passkey

In [Settings → Security](/settings/security), click **Remove** next to the passkey and confirm your password (or an authenticator code). It stops working at once. Also delete it from your device or password manager, which Kite cannot do for you.

The list shows when each passkey was added and last used, so you can spot and remove ones you no longer recognise.

## Lost your devices?

Sign in with your password. If two-factor authentication is on and you lost your authenticator app and recovery codes as well, ask an administrator: under **Accounts → (your account) → Password**, **Reset two-factor and passkeys** turns off your authenticator app, deletes your recovery codes and passkeys, and signs you out everywhere. You then sign in with your password and set things up again.

## For administrators

- Passkeys need the database update with migration 0112, applied from the Admin overview like other updates. Until then the Security page says passkeys become available after the update, and signing in with a password works as before.
- Kite checks every passkey sign-in itself, on Workers and when self-hosted, with no outside service: the challenge is single use and expires after five minutes, the browser must be on Kite's own address, and the device must have verified the user. Passkey sign-ins have their own limit of 20 attempts per minute per IP address, next to the password sign-in limit.
- Adding, removing and resetting passkeys are recorded in **Admin → Activity**. Backups include the passkeys (public keys only), so a restored account signs in with the same passkeys.
- The design is in [docs/specs/passkeys.md](specs/passkeys.md).
