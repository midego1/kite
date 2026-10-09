# Generated API route inventory

Generated from explicit HTTP exports in `src/app/api/**/route.ts`.
Regenerate with `node scripts/docs-generate.mjs`; verify with `node scripts/docs-check.mjs`.

This is an implementation inventory. The public `/api/v1` surface is described by
[openapi.json](openapi.json); other routes' authentication, authorization,
request/response shapes and error behavior require source review
and [the API guide](api.md). It excludes `/mcp` and Worker email/queue entrypoints.
Implicit framework HEAD/OPTIONS behavior is not listed. The relay has a separate
`GET /health` liveness endpoint; it does not check upstream connectivity.

| Route                                                  | Explicit methods       | Implementation                                                                    |
| ------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------- |
| `/api/accounts/[id]/avatar`                            | GET, POST              | [source](../src/app/api/accounts/[id]/avatar/route.ts)                            |
| `/api/accounts/[id]/mailbox-access`                    | DELETE, GET, POST      | [source](../src/app/api/accounts/[id]/mailbox-access/route.ts)                    |
| `/api/accounts/[id]/mailboxes`                         | GET                    | [source](../src/app/api/accounts/[id]/mailboxes/route.ts)                         |
| `/api/accounts/[id]`                                   | GET, PATCH             | [source](../src/app/api/accounts/[id]/route.ts)                                   |
| `/api/accounts/[id]/transfer-primary`                  | POST                   | [source](../src/app/api/accounts/[id]/transfer-primary/route.ts)                  |
| `/api/accounts`                                        | GET, POST              | [source](../src/app/api/accounts/route.ts)                                        |
| `/api/activity`                                        | GET                    | [source](../src/app/api/activity/route.ts)                                        |
| `/api/admin/agent/models`                              | POST                   | [source](../src/app/api/admin/agent/models/route.ts)                              |
| `/api/admin/agent`                                     | GET, PUT               | [source](../src/app/api/admin/agent/route.ts)                                     |
| `/api/admin/ai-usage`                                  | GET                    | [source](../src/app/api/admin/ai-usage/route.ts)                                  |
| `/api/admin/alerts/active`                             | GET                    | [source](../src/app/api/admin/alerts/active/route.ts)                             |
| `/api/admin/alerts/webhook`                            | DELETE, GET, PUT       | [source](../src/app/api/admin/alerts/webhook/route.ts)                            |
| `/api/admin/alerts/webhook/test`                       | POST                   | [source](../src/app/api/admin/alerts/webhook/test/route.ts)                       |
| `/api/admin/api-keys`                                  | DELETE, GET, POST      | [source](../src/app/api/admin/api-keys/route.ts)                                  |
| `/api/admin/aws`                                       | DELETE, GET, POST, PUT | [source](../src/app/api/admin/aws/route.ts)                                       |
| `/api/admin/general`                                   | GET, PUT               | [source](../src/app/api/admin/general/route.ts)                                   |
| `/api/admin/legacy-import`                             | GET, POST              | [source](../src/app/api/admin/legacy-import/route.ts)                             |
| `/api/admin/legacy-import/routing`                     | GET, POST              | [source](../src/app/api/admin/legacy-import/routing/route.ts)                     |
| `/api/admin/legacy-import/step`                        | POST                   | [source](../src/app/api/admin/legacy-import/step/route.ts)                        |
| `/api/admin/migrations`                                | GET, POST              | [source](../src/app/api/admin/migrations/route.ts)                                |
| `/api/admin/resend-key`                                | DELETE, GET, PUT       | [source](../src/app/api/admin/resend-key/route.ts)                                |
| `/api/admin/search-index`                              | GET, POST              | [source](../src/app/api/admin/search-index/route.ts)                              |
| `/api/agent/actions/confirm`                           | POST                   | [source](../src/app/api/agent/actions/confirm/route.ts)                           |
| `/api/agent/approvals/[id]/confirm`                    | POST                   | [source](../src/app/api/agent/approvals/[id]/confirm/route.ts)                    |
| `/api/agent/approvals/[id]`                            | GET                    | [source](../src/app/api/agent/approvals/[id]/route.ts)                            |
| `/api/agent/approvals`                                 | POST                   | [source](../src/app/api/agent/approvals/route.ts)                                 |
| `/api/agent/availability`                              | GET                    | [source](../src/app/api/agent/availability/route.ts)                              |
| `/api/agent/chat`                                      | POST                   | [source](../src/app/api/agent/chat/route.ts)                                      |
| `/api/agent/conversations/[id]`                        | DELETE, GET            | [source](../src/app/api/agent/conversations/[id]/route.ts)                        |
| `/api/agent/conversations`                             | GET                    | [source](../src/app/api/agent/conversations/route.ts)                             |
| `/api/agent/jobs/[id]/retry`                           | POST                   | [source](../src/app/api/agent/jobs/[id]/retry/route.ts)                           |
| `/api/agent/jobs`                                      | GET                    | [source](../src/app/api/agent/jobs/route.ts)                                      |
| `/api/agent/mcp-keys`                                  | DELETE, GET, POST      | [source](../src/app/api/agent/mcp-keys/route.ts)                                  |
| `/api/agent/settings`                                  | GET, PUT               | [source](../src/app/api/agent/settings/route.ts)                                  |
| `/api/api-keys`                                        | DELETE, GET, POST      | [source](../src/app/api/api-keys/route.ts)                                        |
| `/api/attachment-policy`                               | GET                    | [source](../src/app/api/attachment-policy/route.ts)                               |
| `/api/audit-logs`                                      | GET                    | [source](../src/app/api/audit-logs/route.ts)                                      |
| `/api/auth/accounts/[userId]/avatar`                   | GET                    | [source](../src/app/api/auth/accounts/[userId]/avatar/route.ts)                   |
| `/api/auth/accounts`                                   | GET                    | [source](../src/app/api/auth/accounts/route.ts)                                   |
| `/api/auth/login`                                      | POST                   | [source](../src/app/api/auth/login/route.ts)                                      |
| `/api/auth/logout`                                     | POST                   | [source](../src/app/api/auth/logout/route.ts)                                     |
| `/api/auth/me`                                         | GET                    | [source](../src/app/api/auth/me/route.ts)                                         |
| `/api/auth/mfa/verify`                                 | POST                   | [source](../src/app/api/auth/mfa/verify/route.ts)                                 |
| `/api/auth/password-reset/confirm`                     | POST                   | [source](../src/app/api/auth/password-reset/confirm/route.ts)                     |
| `/api/auth/password-reset/request`                     | POST                   | [source](../src/app/api/auth/password-reset/request/route.ts)                     |
| `/api/auth/register`                                   | POST                   | [source](../src/app/api/auth/register/route.ts)                                   |
| `/api/auth/switch`                                     | POST                   | [source](../src/app/api/auth/switch/route.ts)                                     |
| `/api/backups/[id]/download`                           | GET                    | [source](../src/app/api/backups/[id]/download/route.ts)                           |
| `/api/backups/[id]`                                    | DELETE                 | [source](../src/app/api/backups/[id]/route.ts)                                    |
| `/api/backups/restore`                                 | POST                   | [source](../src/app/api/backups/restore/route.ts)                                 |
| `/api/backups`                                         | GET, POST, PUT         | [source](../src/app/api/backups/route.ts)                                         |
| `/api/booking/[eventId]`                               | DELETE, PATCH          | [source](../src/app/api/booking/[eventId]/route.ts)                               |
| `/api/booking`                                         | GET, POST              | [source](../src/app/api/booking/route.ts)                                         |
| `/api/booking/settings`                                | PATCH                  | [source](../src/app/api/booking/settings/route.ts)                                |
| `/api/branding/icon`                                   | GET                    | [source](../src/app/api/branding/icon/route.ts)                                   |
| `/api/branding`                                        | GET, PUT               | [source](../src/app/api/branding/route.ts)                                        |
| `/api/calendar/events/[eventId]`                       | DELETE, PATCH          | [source](../src/app/api/calendar/events/[eventId]/route.ts)                       |
| `/api/calendar/events`                                 | GET, POST              | [source](../src/app/api/calendar/events/route.ts)                                 |
| `/api/contacts/avatar`                                 | DELETE, GET, POST      | [source](../src/app/api/contacts/avatar/route.ts)                                 |
| `/api/contacts/block`                                  | POST                   | [source](../src/app/api/contacts/block/route.ts)                                  |
| `/api/contacts`                                        | GET, PATCH             | [source](../src/app/api/contacts/route.ts)                                        |
| `/api/domains/[id]/dns`                                | GET                    | [source](../src/app/api/domains/[id]/dns/route.ts)                                |
| `/api/domains/[id]/dns/setup`                          | POST                   | [source](../src/app/api/domains/[id]/dns/setup/route.ts)                          |
| `/api/domains/[id]/receiving/[provider]`               | GET, POST              | [source](../src/app/api/domains/[id]/receiving/[provider]/route.ts)               |
| `/api/domains/[id]/receiving`                          | DELETE, GET, PUT       | [source](../src/app/api/domains/[id]/receiving/route.ts)                          |
| `/api/domains/[id]/resend`                             | GET, POST              | [source](../src/app/api/domains/[id]/resend/route.ts)                             |
| `/api/domains/[id]`                                    | DELETE, GET            | [source](../src/app/api/domains/[id]/route.ts)                                    |
| `/api/domains/[id]/sending`                            | DELETE, GET, PUT       | [source](../src/app/api/domains/[id]/sending/route.ts)                            |
| `/api/domains/[id]/ses`                                | GET, POST              | [source](../src/app/api/domains/[id]/ses/route.ts)                                |
| `/api/domains/check`                                   | POST                   | [source](../src/app/api/domains/check/route.ts)                                   |
| `/api/domains`                                         | GET, POST              | [source](../src/app/api/domains/route.ts)                                         |
| `/api/drafts/[id]/attachments/[attachmentId]`          | DELETE                 | [source](../src/app/api/drafts/[id]/attachments/[attachmentId]/route.ts)          |
| `/api/drafts/[id]/attachments`                         | POST                   | [source](../src/app/api/drafts/[id]/attachments/route.ts)                         |
| `/api/drafts/[id]`                                     | DELETE, GET, PATCH     | [source](../src/app/api/drafts/[id]/route.ts)                                     |
| `/api/drafts`                                          | GET, POST              | [source](../src/app/api/drafts/route.ts)                                          |
| `/api/export/messages`                                 | GET                    | [source](../src/app/api/export/messages/route.ts)                                 |
| `/api/folders`                                         | GET, POST              | [source](../src/app/api/folders/route.ts)                                         |
| `/api/import/imap/folders`                             | POST                   | [source](../src/app/api/import/imap/folders/route.ts)                             |
| `/api/import/imap`                                     | POST                   | [source](../src/app/api/import/imap/route.ts)                                     |
| `/api/import/jobs/[id]`                                | DELETE                 | [source](../src/app/api/import/jobs/[id]/route.ts)                                |
| `/api/import/jobs`                                     | GET, POST              | [source](../src/app/api/import/jobs/route.ts)                                     |
| `/api/import/messages`                                 | POST                   | [source](../src/app/api/import/messages/route.ts)                                 |
| `/api/inbound/resend`                                  | POST                   | [source](../src/app/api/inbound/resend/route.ts)                                  |
| `/api/inbound`                                         | POST                   | [source](../src/app/api/inbound/route.ts)                                         |
| `/api/inbound/ses`                                     | POST                   | [source](../src/app/api/inbound/ses/route.ts)                                     |
| `/api/mailboxes/[id]/access`                           | DELETE, GET, POST      | [source](../src/app/api/mailboxes/[id]/access/route.ts)                           |
| `/api/mailboxes/[id]/aliases`                          | DELETE, GET, POST      | [source](../src/app/api/mailboxes/[id]/aliases/route.ts)                          |
| `/api/mailboxes/[id]/avatar`                           | GET, POST              | [source](../src/app/api/mailboxes/[id]/avatar/route.ts)                           |
| `/api/mailboxes/[id]`                                  | DELETE, GET, PATCH     | [source](../src/app/api/mailboxes/[id]/route.ts)                                  |
| `/api/mailboxes`                                       | GET, POST              | [source](../src/app/api/mailboxes/route.ts)                                       |
| `/api/messages/[messageId]/attachments/[attachmentId]` | GET                    | [source](../src/app/api/messages/[messageId]/attachments/[attachmentId]/route.ts) |
| `/api/messages/[messageId]/metadata`                   | GET                    | [source](../src/app/api/messages/[messageId]/metadata/route.ts)                   |
| `/api/messages/[messageId]/original`                   | GET                    | [source](../src/app/api/messages/[messageId]/original/route.ts)                   |
| `/api/messages/[messageId]/read`                       | POST                   | [source](../src/app/api/messages/[messageId]/read/route.ts)                       |
| `/api/messages/[messageId]`                            | GET                    | [source](../src/app/api/messages/[messageId]/route.ts)                            |
| `/api/messages/[messageId]/snooze`                     | DELETE, POST           | [source](../src/app/api/messages/[messageId]/snooze/route.ts)                     |
| `/api/messages/[messageId]/star`                       | POST                   | [source](../src/app/api/messages/[messageId]/star/route.ts)                       |
| `/api/messages/[messageId]/status`                     | POST                   | [source](../src/app/api/messages/[messageId]/status/route.ts)                     |
| `/api/messages/[messageId]/thread`                     | GET                    | [source](../src/app/api/messages/[messageId]/thread/route.ts)                     |
| `/api/messages/bulk`                                   | POST                   | [source](../src/app/api/messages/bulk/route.ts)                                   |
| `/api/messages/counts`                                 | GET                    | [source](../src/app/api/messages/counts/route.ts)                                 |
| `/api/messages/empty`                                  | POST                   | [source](../src/app/api/messages/empty/route.ts)                                  |
| `/api/messages/navigation`                             | GET                    | [source](../src/app/api/messages/navigation/route.ts)                             |
| `/api/messages`                                        | GET                    | [source](../src/app/api/messages/route.ts)                                        |
| `/api/profile/avatar`                                  | DELETE, GET, POST      | [source](../src/app/api/profile/avatar/route.ts)                                  |
| `/api/public/booking/[eventId]`                        | GET, POST              | [source](../src/app/api/public/booking/[eventId]/route.ts)                        |
| `/api/public/booking`                                  | GET                    | [source](../src/app/api/public/booking/route.ts)                                  |
| `/api/routing-rules/[id]`                              | DELETE, PATCH          | [source](../src/app/api/routing-rules/[id]/route.ts)                              |
| `/api/routing-rules/domain/[id]`                       | DELETE, PATCH          | [source](../src/app/api/routing-rules/domain/[id]/route.ts)                       |
| `/api/routing-rules/domain`                            | GET, POST              | [source](../src/app/api/routing-rules/domain/route.ts)                            |
| `/api/routing-rules`                                   | GET, POST              | [source](../src/app/api/routing-rules/route.ts)                                   |
| `/api/seed`                                            | POST                   | [source](../src/app/api/seed/route.ts)                                            |
| `/api/send`                                            | POST                   | [source](../src/app/api/send/route.ts)                                            |
| `/api/send/undo`                                       | POST                   | [source](../src/app/api/send/undo/route.ts)                                       |
| `/api/settings/assistant`                              | GET, PATCH             | [source](../src/app/api/settings/assistant/route.ts)                              |
| `/api/settings/forwarding`                             | PATCH                  | [source](../src/app/api/settings/forwarding/route.ts)                             |
| `/api/settings/mfa/confirm`                            | POST                   | [source](../src/app/api/settings/mfa/confirm/route.ts)                            |
| `/api/settings/mfa/disable`                            | POST                   | [source](../src/app/api/settings/mfa/disable/route.ts)                            |
| `/api/settings/mfa/enroll`                             | POST                   | [source](../src/app/api/settings/mfa/enroll/route.ts)                             |
| `/api/settings/mfa/recovery-codes`                     | POST                   | [source](../src/app/api/settings/mfa/recovery-codes/route.ts)                     |
| `/api/settings/mfa`                                    | GET                    | [source](../src/app/api/settings/mfa/route.ts)                                    |
| `/api/settings/password`                               | PATCH                  | [source](../src/app/api/settings/password/route.ts)                               |
| `/api/settings/profile`                                | PATCH                  | [source](../src/app/api/settings/profile/route.ts)                                |
| `/api/settings/recipient-addresses`                    | GET, PATCH             | [source](../src/app/api/settings/recipient-addresses/route.ts)                    |
| `/api/settings/sending`                                | GET, PATCH             | [source](../src/app/api/settings/sending/route.ts)                                |
| `/api/settings/shortcuts`                              | GET, PATCH             | [source](../src/app/api/settings/shortcuts/route.ts)                              |
| `/api/settings/spam`                                   | GET, PATCH             | [source](../src/app/api/settings/spam/route.ts)                                   |
| `/api/settings/time-zone`                              | PATCH                  | [source](../src/app/api/settings/time-zone/route.ts)                              |
| `/api/settings/trash-retention`                        | GET, PATCH             | [source](../src/app/api/settings/trash-retention/route.ts)                        |
| `/api/setup/domain/mx`                                 | POST                   | [source](../src/app/api/setup/domain/mx/route.ts)                                 |
| `/api/setup/domain`                                    | POST                   | [source](../src/app/api/setup/domain/route.ts)                                    |
| `/api/setup/prepare`                                   | POST                   | [source](../src/app/api/setup/prepare/route.ts)                                   |
| `/api/setup/status`                                    | GET                    | [source](../src/app/api/setup/status/route.ts)                                    |
| `/api/shared-files/[id]`                               | GET                    | [source](../src/app/api/shared-files/[id]/route.ts)                               |
| `/api/templates/[id]`                                  | DELETE                 | [source](../src/app/api/templates/[id]/route.ts)                                  |
| `/api/templates`                                       | GET, POST              | [source](../src/app/api/templates/route.ts)                                       |
| `/api/v1/accounts/[id]`                                | GET, PATCH             | [source](../src/app/api/v1/accounts/[id]/route.ts)                                |
| `/api/v1/accounts`                                     | GET, POST              | [source](../src/app/api/v1/accounts/route.ts)                                     |
| `/api/v1/domains/[id]/dns`                             | GET                    | [source](../src/app/api/v1/domains/[id]/dns/route.ts)                             |
| `/api/v1/domains/[id]/dns/setup`                       | POST                   | [source](../src/app/api/v1/domains/[id]/dns/setup/route.ts)                       |
| `/api/v1/domains/[id]`                                 | DELETE, GET            | [source](../src/app/api/v1/domains/[id]/route.ts)                                 |
| `/api/v1/domains`                                      | GET, POST              | [source](../src/app/api/v1/domains/route.ts)                                      |
| `/api/v1/mailboxes/[id]`                               | DELETE, GET, PATCH     | [source](../src/app/api/v1/mailboxes/[id]/route.ts)                               |
| `/api/v1/mailboxes`                                    | GET, POST              | [source](../src/app/api/v1/mailboxes/route.ts)                                    |
| `/api/v1/messages`                                     | GET                    | [source](../src/app/api/v1/messages/route.ts)                                     |
| `/api/v1/send`                                         | POST                   | [source](../src/app/api/v1/send/route.ts)                                         |
| `/api/webhooks/[id]/deliveries/[deliveryId]/retry`     | POST                   | [source](../src/app/api/webhooks/[id]/deliveries/[deliveryId]/retry/route.ts)     |
| `/api/webhooks/[id]/deliveries`                        | GET                    | [source](../src/app/api/webhooks/[id]/deliveries/route.ts)                        |
| `/api/webhooks/[id]`                                   | DELETE, GET, PATCH     | [source](../src/app/api/webhooks/[id]/route.ts)                                   |
| `/api/webhooks/[id]/test`                              | POST                   | [source](../src/app/api/webhooks/[id]/test/route.ts)                              |
| `/api/webhooks`                                        | GET, POST              | [source](../src/app/api/webhooks/route.ts)                                        |
