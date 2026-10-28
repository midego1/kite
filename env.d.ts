interface CloudflareEnv {
	DB: D1Database;
	EMAIL: SendEmail;
	BUCKET: R2Bucket;
	INBOUND_QUEUE: Queue<import("./src/lib/email/inbound").InboundQueueMessage>;
	// The agent queue also carries writing style backfills and background IMAP import jobs.
	AGENT_QUEUE?: Queue<
		| { kind: "agent.draft"; jobId: string }
		| { kind: "agent.triage"; jobId: string }
		| import("./src/lib/agent/writing-style").StyleBackfillMessage
		| import("./src/lib/import/jobs").ImportJobQueueMessage
	>;
	AI?: Ai;
	AI_MODEL?: string;
	AI_BASE_URL?: string;
	AI_API_KEY?: string;
	// The outbound queue also carries webhook retries, manual backup exports and storage migration batches, so that neither needs an extra binding.
	OUTBOUND_QUEUE: Queue<
		| import("./src/lib/email/send").OutboundQueueMessage
		| import("./src/lib/email/webhooks").WebhookRetryMessage
		| import("./src/lib/mailboxes/delete-types").MailboxPurgeMessage
		| import("./src/lib/backups/queue-types").BackupRunMessage
		| import("./src/lib/storage/migration-utils").StorageMigrateMessage
	>;
	ASSETS: Fetcher;
	IMAGES: ImagesBinding;
	WORKER_SELF_REFERENCE: Fetcher;
	REALTIME: DurableObjectNamespace<import("./src/lib/realtime/hub").RealtimeHub>;
	/** Analytics Engine dataset; absent on older deployments, a no-op on Node. */
	METRICS?: AnalyticsEngineDataset;
	CF_VERSION_METADATA?: WorkerVersionMetadata;
	LOGIN_RATE_LIMIT?: RateLimit;
	AGENT_RATE_LIMIT?: RateLimit;
	BOOKING_RATE_LIMIT?: RateLimit;
	/** Per-user budget on the remote image proxy (`/api/remote-images`); absent on older deployments. */
	REMOTE_IMAGE_RATE_LIMIT?: RateLimit;
	/** Drive public link views and password attempts, keyed by IP; absent on older deployments. */
	DRIVE_LINK_RATE_LIMIT?: RateLimit;
	CF_TOKEN?: string;
	CF_API_KEY?: string;
	CF_EMAIL?: string;
	TURNSTILE_SECRET_KEY?: string;
	/** "node" when served by the self-hosted runtime in server/; unset on Workers. */
	KITE_RUNTIME?: "node";
	/** Shared secret the Cloudflare email relay signs inbound webhooks with (self-hosted only). */
	INBOUND_WEBHOOK_SECRET?: string;
	/** Cloudflare account id, needed for the Email Sending REST API off Workers. */
	CF_ACCOUNT_ID?: string;
	/** Public origin of this install (https://mail.example.com) when it sits behind a proxy. */
	APP_URL?: string;
	/** Database size limit in bytes for the warnings and the import guard; defaults to D1's 10 GB (Workers Free: 500000000). Ignored on Node. */
	D1_MAX_BYTES?: string;
	/** "off" disables operational alert emails; anything else leaves them on. */
	OPERATIONAL_ALERTS?: string;
	/**
	 * "1" or "true" applies pending database migrations by itself, with the same safety backup the
	 * admin "Apply now" button takes, as soon as the app notices them (see docs/deployment.md).
	 * Off by default; an environment variable because a stored setting could not be read until the
	 * migration it would apply had run.
	 */
	AUTO_APPLY_MIGRATIONS?: string;
	/** "0", "false", "off" or "no" forces the opt-in usage statistics off (src/lib/telemetry/); nothing forces them on. */
	KITE_TELEMETRY?: string;
	/** Overrides the collector the daily usage heartbeat is posted to; https only. Empty means nothing is sent. */
	KITE_TELEMETRY_URL?: string;
	/** Dev/test only: "1" or "true" lets the alert webhook use plain http to loopback hosts; ignored in production. */
	ALERT_WEBHOOK_ALLOW_INSECURE?: string;
	/** Dev/test only: "1" lets a custom AI provider be http://127.0.0.1 or http://localhost (the fake model); ignored in production. */
	AI_ALLOW_INSECURE_LOOPBACK?: string;
	/** Dev/test only, with AI_ALLOW_INSECURE_LOOPBACK: a shorter timeout (ms) for Summarize requests, so specs can make one time out; ignored in production. */
	AI_TEST_TIMEOUT_MS?: string;
	/** Dev/test only: "1" lets the remote image proxy fetch http://127.0.0.1 on any port (the e2e image server); ignored in production. */
	REMOTE_IMAGES_ALLOW_LOOPBACK?: string;
	/** Dev/test only: "1" or "true" lets an object store use plain http and loopback hosts (the fake S3, local MinIO); ignored in production. */
	STORAGE_ALLOW_INSECURE_ENDPOINT?: string;
	/** Node server only: "1" or "true" lets an object store be a private or LAN host, such as MinIO beside the server; ignored on Workers. */
	STORAGE_ALLOW_PRIVATE_ENDPOINTS?: string;
	/** Optional read-only S3 store from the environment (Docker bootstrap); see docs/self-hosting.md. Never written to D1. */
	STORAGE_S3_ENDPOINT?: string;
	STORAGE_S3_REGION?: string;
	STORAGE_S3_BUCKET?: string;
	STORAGE_S3_ACCESS_KEY_ID?: string;
	STORAGE_S3_SECRET_ACCESS_KEY?: string;
	/** `virtual` or `path` (default `path`). */
	STORAGE_S3_ADDRESSING?: string;
	/** Comma-separated classes routed to the environment store when no saved route names them: `mail,drive,backups`. */
	STORAGE_S3_CLASSES?: string;
	/** abuse.ch Auth-Key; when set, inbound spam checks look up risky links and attachment hashes on URLhaus and ThreatFox. */
	URLHAUS_AUTH_KEY?: string;
	/** Alias of `URLHAUS_AUTH_KEY`, used only when that is unset. */
	ABUSE_CH_AUTH_KEY?: string;
	/** Dev/test only: an http://127.0.0.1 or http://localhost origin that stands in for both abuse.ch APIs (the e2e fake); ignored in production. */
	ABUSE_CH_TEST_ORIGIN?: string;
	/** When set, first-run setup and the first registration must present this token. */
	SETUP_TOKEN?: string;
	/** Any long random string; when set, provider secrets in app_settings are stored encrypted (AES-GCM, key derived with HKDF). */
	APP_ENCRYPTION_KEY?: string;
	/** Most messages one user may send per rolling hour (default 100); "0" removes the limit. */
	SEND_LIMIT_PER_HOUR?: string;
	/** Most messages one user may send per rolling day (default 500); "0" removes the limit. */
	SEND_LIMIT_PER_DAY?: string;
	/** Self-hosted only: resolves a hostname to its addresses so outbound requests can refuse private ones. */
	RESOLVE_HOST?: (hostname: string) => Promise<string[]>;
}
