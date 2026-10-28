### Added

- Save several AI providers in [Admin → Agent](/agent) and switch between them with **Use this provider**, without typing the API key or models again: each saved provider keeps its name, base URL, sealed key, models and rates, and exactly one is in use for chat, Write with Kite, automatic reading, summaries and spend. The provider in use cannot be deleted; switch first. Adding, switching and deleting a provider are listed on [Activity](/activity).
- A mailbox whose chosen model the provider in use does not offer uses the provider's default model, and its assistant settings say so.

### Changed

- Database migration 0077 adds the saved providers and copies the provider configured until now into the first one. Apply it from the admin overview; until then Admin → Agent keeps the single provider form and works as before.
