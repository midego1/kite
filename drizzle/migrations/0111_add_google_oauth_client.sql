-- Sign in with Google for connected Gmail and Google Workspace accounts (ROADMAP milestone 6 item 4, spec §15.6).
-- Everything else Google needs is already there from 0105: the refresh token in `external_accounts.secret`, the
-- cached access token, the compare-and-swap version and `oauth_subject` (Google's `sub`), and `oauth_states` for the
-- sign-ins in progress, whose `provider` says which one. `app_settings.oauth_google_client` is the owner's sealed
-- Google Cloud OAuth client (`{ clientId, clientSecret, hostedDomain }`), read and written with plain SQL like the
-- Microsoft one (`src/lib/external-accounts/oauth-store.ts`), so whole-row reads keep working before this migration.
ALTER TABLE `app_settings` ADD `oauth_google_client` text;
