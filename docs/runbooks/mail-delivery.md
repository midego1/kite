# Mail delivery triage

## Trigger

A message is missing, outbound delivery fails, or queue/relay errors increase.
Use synthetic messages and a human deployment operator for remote inspection.

1. Determine direction, selected provider, UTC window and opaque message/job
   ID. Do not paste sender, recipient, subject, raw MIME or provider credentials.
2. Check app availability with its existing `/api/setup/status` probe. Review
   structured logs by component/event and existing provider delivery status.
   Correlate Worker/Node/relay events with W3C `traceparent` trace IDs and
   compare duration/status events. No external trace collector is configured.
   The relay `GET /health` checks liveness only, without an upstream request;
   callback delivery has a 15-second timeout.
   A successful HTTP probe does not establish end-to-end mail delivery.
3. For Cloudflare inbound routing, verify the existing route targets the same
   Worker/relay and review store/reject/forward outcomes. For Resend/SES check
   the selected receiving configuration and the existing signed callback path.
   Never rename resources or change DNS during agent diagnosis.
4. For outbound delivery, inspect the existing job state and provider result;
   distinguish rate limiting, credentials/configuration and permanent rejection.
   Do not blindly resend: delivery may have succeeded before a timeout. Use
   existing delivery IDs/provider evidence to prevent duplicate mail.
5. Reproduce the relay locally with `npm run test:relay:integration`, then run
   `npm run test:relay` for signature, routing and network failure scenarios.
   These checks use synthetic mail and local workerd, not a live mailbox.
6. Prepare a bounded fix, run `npm run check:mission` and document the scenario.
   A human reviews and merges. Only the operator authorizes retry/configuration
   changes on the deployed service.

Recovery means synthetic inbound and outbound mail both reach their expected
outcome, retries settle, and the operator confirms the affected window is
understood. Escalate suspected loss or unauthorized delivery via
[incident response](incident.md). See [provider configuration](../providers.md).
