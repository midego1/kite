import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./bundle-directory.mjs";
import { startFakeS3 } from "./fake-s3.mjs";
import { migrationsDir } from "./module-database.mjs";
import { root } from "./modules-bundle.mjs";

const ENTRIES = {
	migration: "src/lib/storage/migration.ts",
	stores: "src/lib/storage/stores.ts",
	routeSwitch: "src/lib/storage/route-switch.ts",
	config: "src/lib/storage/config.ts",
	state: "src/lib/modules/state.ts",
	sqlite: "server/runtime/sqlite-database.ts",
	migrate: "server/runtime/migrate.ts",
	files: "server/runtime/file-bucket.ts",
	secrets: "src/lib/security/secret-box.ts",
	session: "src/lib/auth/session.ts",
	driveUploads: "src/lib/drive/uploads.ts",
	driveContent: "src/lib/drive/content.ts",
	overviewRoute: "src/app/api/admin/storage/route.ts",
	storesRoute: "src/app/api/admin/storage/stores/route.ts",
	storeRoute: "src/app/api/admin/storage/stores/[id]/route.ts",
	classRoute: "src/app/api/admin/storage/routes/[class]/route.ts",
	migrationRoute: "src/app/api/admin/storage/migrations/[id]/route.ts",
};

const ENCRYPTION_KEY = "invented-encryption-key-for-storage-tests";
export const APP_ORIGIN = "http://localhost:3200";

/**
 * The storage services bundled without the module-server stubs of `bundleModules`, because the migration
 * reaches Drive files through the real Drive capabilities. Splitting keeps one config cache and one module
 * registry across the entries; `extraEntries` adds more by name. Returns the loaded entries, a fake S3 with the
 * given buckets and `fixture(t)`.
 */
export async function loadStorageServices(prefix, buckets, extraEntries = {}) {
	const entries = { ...ENTRIES, ...extraEntries };
	const outDir = makeBundleDirectory(prefix);
	const scratch = mkdtempSync(join(tmpdir(), prefix));
	await build({
		entryPoints: Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, join(root, file)])),
		outdir: outDir,
		outExtension: { ".js": ".mjs" },
		bundle: true,
		splitting: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		packages: "external",
		tsconfig: join(root, "tsconfig.json"),
		alias: {
			"cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"),
			"next/server": "next/server.js",
			"next/headers": "next/headers.js",
			"next/navigation": "next/navigation.js",
		},
	});
	const lib = {};
	for (const name of Object.keys(entries)) lib[name] = await import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
	const fake = await startFakeS3({ buckets });
	after(async () => {
		await fake.close();
		rmSync(outDir, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	});
	let counter = 0;

	/** A migrated in-memory database, a file bucket as the default store, a recording queue and one owner. */
	async function fixture(t, extraEnv = {}) {
		lib.config.clearStorageConfigCache();
		lib.state.clearModuleStateCache();
		const db = new lib.sqlite.SqliteDatabase(":memory:");
		await lib.migrate.applyMigrations(db, migrationsDir);
		const queue = [];
		const env = {
			DB: db,
			BUCKET: lib.files.openFileBucket(join(scratch, `default-${++counter}`)),
			APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
			KITE_RUNTIME: "node",
			STORAGE_ALLOW_INSECURE_ENDPOINT: "1",
			STORAGE_ALLOW_PRIVATE_ENDPOINTS: "1",
			OUTBOUND_QUEUE: { send: async (message, options) => void queue.push({ message, options }) },
			...extraEnv,
		};
		globalThis.__kiteNodeEnv = env;
		for (const bucket of fake.buckets.values()) {
			bucket.objects.clear();
			bucket.cors = null;
			bucket.lifecycle = null;
		}
		fake.state.denied.clear();
		db.db.exec(`
			INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
				('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1),
				('second', 'second@example.com', 'hash', 'Second admin', 'admin', 0, 1);
			INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
			INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		`);
		t.after(() => {
			delete globalThis.__kiteNodeEnv;
			lib.config.clearStorageConfigCache();
			db.db.close();
		});
		return { env, db, queue };
	}

	/** A store row for one fake bucket, checked just now so a route may switch to it. */
	async function addStore(env, id, bucket, name = `Store ${id}`) {
		const credentials = await lib.secrets.sealSetting(
			env,
			JSON.stringify({ accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey }),
		);
		env.DB.db
			.prepare(
				`INSERT INTO storage_stores (id, name, provider, endpoint, region, bucket, addressing, credentials, status, last_checked_at, created_at, updated_at)
				 VALUES (?, ?, 'minio', ?, ?, ?, 'path', ?, 'ok', ?, 1, 1)`,
			)
			.run(id, name, `http://${fake.endpoint}`, fake.region, bucket, credentials, Math.floor(Date.now() / 1000));
		lib.config.clearStorageConfigCache();
	}

	return { lib, fake, fixture, addStore };
}
