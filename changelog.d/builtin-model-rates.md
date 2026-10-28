### Added

- Kite now ships a price list with the official per-token prices of well-known models (Anthropic Claude including dated ids such as `claude-haiku-4-5-20251001`, OpenAI, Google Gemini, Workers AI's text models and Groq), each with its source and the date it was read. Models the provider does not price in its model list, such as Claude through the Anthropic API, now show dollar costs on [AI usage](/ai-usage) again. Under **Estimated cost rates** in [Admin → Agent](/agent) these rates appear greyed with "From Kite's price list (as of …) · source"; **Override** sets your own rate and **Use Kite's price** goes back. Your own rate comes first, then a rate the provider publishes, then the price list. The list is updated with Kite releases.
- Admin → Agent shows what was spent today next to the daily spend cap.

### Changed

- Models that get a rate from the price list count against the daily dollar spend caps instead of the input-token allowances, from the moment this release is deployed. The install's cap defaults to $2.00 a day, which an expensive model (Claude Opus 5.5 at $4 / $20 per million tokens, for example) reaches sooner than the 2,000,000-token allowances: check the cap under **Automatic reading** in [Admin → Agent](/agent) and raise it if automatic reading or chat should keep running. Spend recorded earlier today without a rate counts as $0.
- Which model automatic reading and one-line summaries use is unchanged: without a triage model chosen for the mailbox they still pick the cheapest model among the rates entered or published in Admin → Agent, and rates from the price list are not considered for that choice.
