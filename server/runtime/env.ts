import type Database from "better-sqlite3";
import { lookup, resolveTxt } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNoopMetrics } from "../../src/lib/metrics.mjs";
import { mailHostPolicy } from "../../src/lib/net/host-guard-utils";
import { withStorage } from "../../src/lib/storage/router";
import { openFileBucket } from "./file-bucket";
import { openMailer, type Mailer, type MailerConfig } from "./mailer";
import { openAssets, openRateLimiter } from "./misc";
import { adoptLegacyDatabaseFile } from "./data-files";
import { adoptQueueMessages, openQueue, type InProcessQueue } from "./queue";
import { RealtimeHubRegistry } from "./realtime";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite-database";
import { createTcpConnect } from "./tcp-connect";
import type { NodeRuntime } from "./types";

function optional(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function mailerConfig(): MailerConfig {
	const smtp = optional("SMTP_URL");
	if (smtp) return { kind: "smtp", url: smtp };
	const accountId = optional("CF_ACCOUNT_ID");
	const token = optional("CF_TOKEN");
	if (accountId && token) return { kind: "cloudflare", accountId, token };
	return { kind: "none" };
}

/** Messages queued before the Kite rename were stored under `mailflare-<name>`. */
function openKiteQueue<T>(name: string, db: Database.Database) {
	adoptQueueMessages(db, `mailflare-${name}`, `kite-${name}`);
	return openQueue<T>(`kite-${name}`, db);
}

/**
 * Assemble a `CloudflareEnv` for the Node runtime from environment variables
 * and local resources. Everything the app reaches through `getEnv()` is here,
 * so application code does not know which platform it runs on.
 */
export function createNodeRuntime(): NodeRuntime {
	const dataDir = resolve(optional("DATA_DIR") ?? "./data");
	mkdirSync(join(dataDir, "blobs"), { recursive: true });

	const database = openSqliteDatabase(adoptLegacyDatabaseFile(dataDir));
	const bucket = openFileBucket(join(dataDir, "blobs"));
	const mailer = openMailer(mailerConfig());
	const sqlite = (database as unknown as SqliteDatabase).db;
	const inboundQueue = openKiteQueue("inbound", sqlite);
	const outboundQueue = openKiteQueue("outbound", sqlite);
	const agentQueue = openKiteQueue("agent", sqlite);
	const realtime = new RealtimeHubRegistry();
	const publicDir = resolve(optional("PUBLIC_DIR") ?? "./public");
	const mailHosts = mailHostPolicy(
		{
			EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: optional("EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK"),
			EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS: optional("EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS"),
			KITE_RUNTIME: "node",
		},
		process.env.NODE_ENV,
	);

	const platform = {
		DB: database,
		BUCKET: bucket,
		EMAIL: mailer,
		INBOUND_QUEUE: inboundQueue,
		OUTBOUND_QUEUE: outboundQueue,
		AGENT_QUEUE: agentQueue,
		AI_MODEL: optional("AI_MODEL"),
		AI_BASE_URL: optional("AI_BASE_URL"),
		AI_API_KEY: optional("AI_API_KEY"),
		REALTIME: realtime.namespace(),
		ASSETS: openAssets(publicDir),
		IMAGES: undefined as unknown as CloudflareEnv["IMAGES"],
		WORKER_SELF_REFERENCE: undefined as unknown as CloudflareEnv["WORKER_SELF_REFERENCE"],
		METRICS: createNoopMetrics(),
		LOGIN_RATE_LIMIT: openRateLimiter(20, 60),
		AGENT_RATE_LIMIT: openRateLimiter(120, 60),
		BOOKING_RATE_LIMIT: openRateLimiter(5, 60),
		DRIVE_LINK_RATE_LIMIT: openRateLimiter(60, 60),
		// The same budget as wrangler.jsonc, now that the self-hosted server proxies remote images too.
		REMOTE_IMAGE_RATE_LIMIT: openRateLimiter(600, 60),
		CF_TOKEN: optional("CF_TOKEN"),
		CF_API_KEY: optional("CF_API_KEY"),
		CF_EMAIL: optional("CF_EMAIL"),
		TURNSTILE_SECRET_KEY: optional("TURNSTILE_SECRET_KEY"),
		// Marks the runtime for the few places that must behave differently.
		KITE_RUNTIME: "node",
		APP_URL: optional("APP_URL")?.replace(/\/$/, ""),
		INBOUND_WEBHOOK_SECRET: optional("INBOUND_WEBHOOK_SECRET"),
		SETUP_TOKEN: optional("SETUP_TOKEN"),
		URLHAUS_AUTH_KEY: optional("URLHAUS_AUTH_KEY"),
		ABUSE_CH_AUTH_KEY: optional("ABUSE_CH_AUTH_KEY"),
		OPERATIONAL_ALERTS: optional("OPERATIONAL_ALERTS"),
		AUTO_APPLY_MIGRATIONS: optional("AUTO_APPLY_MIGRATIONS"),
		KITE_TELEMETRY: optional("KITE_TELEMETRY"),
		// Not `optional`: an empty value is meaningful (send nothing), unlike an unset one (the default collector).
		KITE_TELEMETRY_URL: process.env.KITE_TELEMETRY_URL,
		ALERT_WEBHOOK_ALLOW_INSECURE: optional("ALERT_WEBHOOK_ALLOW_INSECURE"),
		AI_ALLOW_INSECURE_LOOPBACK: optional("AI_ALLOW_INSECURE_LOOPBACK"),
		AI_TEST_TIMEOUT_MS: optional("AI_TEST_TIMEOUT_MS"),
		STORAGE_ALLOW_INSECURE_ENDPOINT: optional("STORAGE_ALLOW_INSECURE_ENDPOINT"),
		STORAGE_ALLOW_PRIVATE_ENDPOINTS: optional("STORAGE_ALLOW_PRIVATE_ENDPOINTS"),
		STORAGE_S3_ENDPOINT: optional("STORAGE_S3_ENDPOINT"),
		STORAGE_S3_REGION: optional("STORAGE_S3_REGION"),
		STORAGE_S3_BUCKET: optional("STORAGE_S3_BUCKET"),
		STORAGE_S3_ACCESS_KEY_ID: optional("STORAGE_S3_ACCESS_KEY_ID"),
		STORAGE_S3_SECRET_ACCESS_KEY: optional("STORAGE_S3_SECRET_ACCESS_KEY"),
		STORAGE_S3_ADDRESSING: optional("STORAGE_S3_ADDRESSING"),
		STORAGE_S3_CLASSES: optional("STORAGE_S3_CLASSES"),
		APP_ENCRYPTION_KEY: optional("APP_ENCRYPTION_KEY"),
		SEND_LIMIT_PER_HOUR: optional("SEND_LIMIT_PER_HOUR"),
		SEND_LIMIT_PER_DAY: optional("SEND_LIMIT_PER_DAY"),
		RESOLVE_HOST: async (hostname: string) =>
			(await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
		RESOLVE_TXT: resolveTxtRecords,
		EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: optional("EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK"),
		EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS: optional("EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS"),
		EXTERNAL_ACCOUNTS_EXTRA_PORTS: optional("EXTERNAL_ACCOUNTS_EXTRA_PORTS"),
		// Mail server connections (IMAP import): DNS pinned, private addresses refused, certificates verified.
		TCP_CONNECT: createTcpConnect({
			allowPrivate: mailHosts.allowPrivate,
			allowLoopback: mailHosts.allowInsecureLoopback,
		}),
	} as unknown as CloudflareEnv;
	// Wrapped before anything holds the env, so the realtime hub, the scheduler and the queues all see the router.
	const env = withStorage(platform);
	realtime.bindEnv(env);

	return {
		env,
		dataDir,
		database: database as unknown as SqliteDatabase,
		mailer: mailer as unknown as Mailer,
		inboundQueue: inboundQueue as unknown as InProcessQueue,
		outboundQueue: outboundQueue as unknown as InProcessQueue,
		agentQueue: agentQueue as unknown as InProcessQueue,
		realtime,
	};
}

/** TXT records through the system resolver; a name without any (NXDOMAIN, no data) answers an empty list. */
async function resolveTxtRecords(name: string): Promise<string[]> {
	try {
		return (await resolveTxt(name)).map((chunks) => chunks.join(""));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOTFOUND" || code === "ENODATA") return [];
		throw error;
	}
}
