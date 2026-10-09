# Incident response

## Trigger and ownership

Use this procedure for widespread mail failures, unauthorized access, exposed
credentials, or suspected data loss. The deployment operator leads response;
`@midego1` owns repository review. Agents investigate locally and prepare fixes;
production changes require the responsible human operator.

## Triage

1. Record UTC start time, affected deployment/revision, symptoms and estimated
   impact. Keep evidence restricted and follow [PII handling](../pii-handling.md).
2. Check the existing deployment status and sanitized runtime logs. Separate
   application availability, inbound relay/provider errors, outbound provider
   errors and backup/storage failures. Use opaque IDs and counts to correlate.
3. Reproduce with synthetic data locally. `npm run check:mission` covers the
   application and real local relay, with no production credentials.
4. For exposed credentials, identify the scope without displaying the value.
   The authorized operator revokes/rotates at the issuing service, updates the
   deployment secret, and checks affected access. Deleting a Git commit alone
   does not revoke a secret. Avoid copying it into an issue or CI artifact.
5. For unauthorized access/data loss, preserve restricted evidence, limit the
   affected access path through an approved mitigation, and assess backups
   before further writes. Record decisions and operator approval.

## Recovery and closure

Use [delivery triage](mail-delivery.md) or [recovery](recovery.md) as appropriate.
Validate availability and synthetic send/receive separately; review queue retry
counts and backup freshness in the deployment's existing surfaces. An HTTP 200
alone is insufficient. Have the operator assess notification obligations and
coordinate private vulnerability disclosure when relevant.

Close only after the operator confirms recovery. Record impact interval,
root cause, mitigation, validation and assigned prevention tasks with acceptance
criteria. This repository does not provision paging or incident notifications.
