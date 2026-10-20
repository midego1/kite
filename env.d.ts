interface CloudflareEnv {
	DB: D1Database;
	EMAIL: SendEmail;
	BUCKET: R2Bucket;
	INBOUND_QUEUE: Queue<import("./src/lib/email/inbound").InboundQueueMessage>;
	// The agent queue also carries background IMAP import jobs.
	AGENT_QUEUE?: Queue<
		| { kind: "agent.draft"; jobId: string }
		| { kind: "agent.triage"; jobId: string }
		| import("./src/lib/import/jobs").ImportJobQueueMessage
	>;
	AI?: Ai;
	AI_MODEL?: string;
	AI_BASE_URL?: string;
	AI_API_KEY?: string;
	// The outbound queue also carries webhook retries and manual backup exports, so that neither needs an extra binding.
	OUTBOUND_QUEUE: Queue<
		| import("./src/lib/email/send").OutboundQueueMessage
		| import("./src/lib/email/webhooks").WebhookRetryMessage
		| import("./src/lib/mailboxes/delete-types").MailboxPurgeMessage
		| import("./src/lib/backups/queue-types").BackupRunMessage
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
	/** "off" disables operational alert emails; anything else leaves them on. */
	OPERATIONAL_ALERTS?: string;
	/**
	 * "1" or "true" applies pending database migrations by itself, with the same safety backup the
	 * admin "Apply now" button takes, as soon as the app notices them (see docs/deployment.md).
	 * Off by default; an environment variable because a stored setting could not be read until the
	 * migration it would apply had run.
	 */
	AUTO_APPLY_MIGRATIONS?: string;
	/** Dev/test only: "1" or "true" lets the alert webhook use plain http to loopback hosts; ignored in production. */
	ALERT_WEBHOOK_ALLOW_INSECURE?: string;
	/** Dev/test only: "1" lets a custom AI provider be http://127.0.0.1 or http://localhost (the fake model); ignored in production. */
	AI_ALLOW_INSECURE_LOOPBACK?: string;
	/** Dev/test only: "1" lets the remote image proxy fetch http://127.0.0.1 on any port (the e2e image server); ignored in production. */
	REMOTE_IMAGES_ALLOW_LOOPBACK?: string;
	/** abuse.ch Auth-Key; when set, inbound spam checks look up risky links and attachment hashes on URLhaus. */
	URLHAUS_AUTH_KEY?: string;
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
