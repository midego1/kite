### Fixed

- **Summarize** no longer fails on long conversations with "The AI provider could not finish this". A summary may now use up to 1,600 output tokens instead of 400, which cut off the answer for long threads (the cut-off was then reported as a provider error), and the prompt states the length limits the checks keep.

### Changed

- AI errors now say what went wrong and what to do, the same way in the assistant chat, Write with Kite, summaries and their translations, and automatic reading: the AI took too long, the answer was cut off, the provider refused the request or had a problem (with its HTTP status), the model is unavailable or the email too long for it, the answer was not usable (and why), a spend cap or rate limit was reached, the external provider is not allowed, the assistant is off or no provider is set up, or the provider could not be reached. A **Details** disclosure shows the error code, the model, the provider and the time, **Try again** appears where it helps, and the primary admin gets a link to [Admin → Agent](/agent) for a setting that needs fixing. The provider's own error text is no longer shown in chat or stored on automatic jobs.
- Activity names why an automatic job failed or went on without the model, such as "it took too long (timeout)", instead of the provider's message.

### Added

- [Admin → Agent](/agent) lists the last 20 **Recent AI errors** (feature, code, model, provider, HTTP status, duration, token counts and finish reason; never what was asked or answered), so the primary admin can see what failed without server access. They are kept in the audit log; no migration is needed.
