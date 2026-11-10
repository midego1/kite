### Added

- Outlook.com, Hotmail and Microsoft 365 accounts can now be connected under [Settings → Connected accounts](/settings/connected-accounts) with **Sign in with Microsoft**: new mail arrives, existing mail can be imported and you can send as the address, without a password. When Microsoft stops accepting the sign-in, the account shows **Reconnect**.
  ![The connect dialog with Outlook.com or Microsoft 365 chosen and the Sign in with Microsoft button](/changelog/2026-11-10-sign-in-with-microsoft-light.webp)
- The owner turns this on once in [Admin → General](/general) by entering this Kite's own Microsoft app registration; the client secret is checked with Microsoft and saved encrypted. This needs a database update applied from the Admin overview; the [setup steps](https://github.com/midego1/kite/blob/main/docs/providers.md#microsoft-sign-in-for-connected-accounts) walk through the Microsoft side.
  ![Microsoft sign-in in the Connected accounts card of Admin → General, with the redirect URI to register](/changelog/2026-11-10-microsoft-sign-in-admin-light.webp)
