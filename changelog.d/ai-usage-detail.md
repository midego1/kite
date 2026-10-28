### Added

- [AI usage](/ai-usage) is much more detailed. Hover over or focus a bar in the chart (arrow keys move between days) to see that day's input, output and total tokens, requests, failures, estimated cost, requests without a rate, and a breakdown by model and by feature. Switch between the last 7, 30 or 90 days, and chart tokens, cost or requests. New sections show today's spend against the install's daily cap, the token allowances and each mailbox's own cap; succeeded versus failed requests with the most common errors; and breakdowns by model, provider, feature and mailbox (only mailboxes you can open are named), each with requests, tokens, cost and share. The activity table filters by model, provider, feature and status, and each row opens to show its feature, mailbox, status or error, duration, finish reason, cost and the rate it was counted at.
- Kite's price list now has DeepSeek's models (`deepseek-flash`, which serves DeepSeek V4.1 Flash, and `deepseek-v4-pro`), counted at DeepSeek's peak rate.

### Changed

- Requests that stored no cost, because they ran before their model had a rate, are now priced on [AI usage](/ai-usage) at today's rate and marked estimated, instead of being left out of the spend. The page lists the models that still have no rate, with a link to set one in [Admin → Agent](/agent).
- **Database migration 0077** adds status, error code, duration, finish reason and the rate used to each AI usage row. Apply it from the Admin overview; until then AI usage shows those details as not recorded and everything else works as before.

### Fixed

- A model id written the way routers such as OpenRouter and Haimaker write it, with the vendor in front (`anthropic/claude-opus-5-5`, `deepseek/deepseek-v4.1-flash`), now gets the vendor's price from Kite's price list. Such models now count against the daily dollar spend cap instead of the token allowances.
