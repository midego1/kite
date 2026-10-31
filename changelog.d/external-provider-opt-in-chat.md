### Security

- The primary admin's external-provider opt-in now also covers the assistant chat and the older **Automatically draft replies** setting, as it already did for automatic reading, Write with Kite and summaries. With an external provider (anything but Workers AI) and the opt-in off, the assistant panel says the provider is external and that the primary admin has not allowed sending mail to it, with a link to [Admin → Agent](/agent) for the primary admin, and chat stays off; automatic drafts are skipped with the reason in Activity. The opt-in is checked again before every step of a chat answer. **If your install uses an external provider for chat, the primary admin has to turn on the opt-in once for chat to keep working.**

### Changed

- The switch is now called **Allow an external AI provider to read mail** in [Admin → Agent](/agent), and its description lists every feature it covers.
