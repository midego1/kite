import type Database from "better-sqlite3";
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNoopMetrics } from "../../src/lib/metrics.mjs";
import { openFileBucket } from "./file-bucket";
import { openMailer, type Mailer, type MailerConfig } from "./mailer";
import { openAssets, openRateLimiter } from "./misc";
import { adoptLegacyDatabaseFile } from "./data-files";
import { adoptQueueMessages, openQueue, type InProcessQueue } from "./queue";
import { RealtimeHubRegistry } from "./realtime";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite-database";
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

	const env = {
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
		CF_TOKEN: optional("CF_TOKEN"),
		CF_API_KEY: optional("CF_API_KEY"),
		CF_EMAIL: optional("CF_EMAIL"),
		TURNSTILE_SECRET_KEY: optional("TURNSTILE_SECRET_KEY"),
		// Marks the runtime for the few places that must behave differently.
		KITE_RUNTIME: "node",
		APP_URL: optional("APP_URL")?.replace(/\/$/, ""),
		INBOUND_WEBHOOK_SECRET: optional("INBOUND_WEBHOOK_SECRET"),
		SETUP_TOKEN: optional("SETUP_TOKEN"),
		OPERATIONAL_ALERTS: optional("OPERATIONAL_ALERTS"),
		ALERT_WEBHOOK_ALLOW_INSECURE: optional("ALERT_WEBHOOK_ALLOW_INSECURE"),
		APP_ENCRYPTION_KEY: optional("APP_ENCRYPTION_KEY"),
		RESOLVE_HOST: async (hostname: string) =>
			(await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
	} as unknown as CloudflareEnv;
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
