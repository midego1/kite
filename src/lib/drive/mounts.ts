import { and, asc, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { driveMounts } from "@/db/schema/drive";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { assertPublicHttpUrl } from "@/lib/security/outbound-url";
import { openSetting, sealSetting } from "@/lib/security/secret-box";
import { endpointPolicyFor } from "@/lib/storage/config";
import { DriveRefusal, fail, ok } from "./errors";
import { allowMountCheck } from "./rate-limit";
import type { DriveAnswer, DriveMountDto, DriveUser } from "./types";
import { WebdavClient, WebdavError } from "./webdav-client";
import { isAllowedLocalAddress, parseWebdavUrl, webdavAddressProblem } from "./webdav-path-utils";
import { parseMountCredentials, webdavFailure, type MountCredentials } from "./mount-utils";

const log = createLogger("drive");

export type DriveMountRow = typeof driveMounts.$inferSelect;

/** @public Exercised by the unit tests. */
export const MAX_MOUNTS_PER_USER = 20;

const ENCRYPTION_REQUIRED =
	"Linked folders need APP_ENCRYPTION_KEY, so app passwords are only ever saved encrypted. Ask your admin.";

export const toMountDto = (row: DriveMountRow): DriveMountDto => ({
	id: row.id,
	label: row.label,
	url: row.baseUrl,
	username: row.username,
	status: row.status,
	lastError: row.lastError,
	createdAt: row.createdAt.toISOString(),
});

/**
 * The address guard for every WebDAV request and redirect: the literal check under the storage endpoint flags,
 * then, on the Node server, every address the host resolves to. Workers cannot reach private networks at all.
 */
function webdavGuard(env: CloudflareEnv): (url: URL) => Promise<void> {
	const policy = endpointPolicyFor(env);
	return async (url) => {
		const problem = webdavAddressProblem(url, policy);
		if (problem) throw new Error(problem);
		if (isAllowedLocalAddress(url, policy)) return;
		await assertPublicHttpUrl(env, url.href);
	};
}

export function webdavClient(env: CloudflareEnv, credentials: MountCredentials): WebdavClient {
	return new WebdavClient(
		{ url: credentials.url, username: credentials.username, password: credentials.password },
		{ guard: webdavGuard(env) },
	);
}

/**
 * The folder must answer a PROPFIND with these credentials, as a folder, before anything is saved. Each check is a
 * request to an address the user chose, so it counts against the user's budget.
 */
async function checkFolder(
	env: CloudflareEnv,
	user: DriveUser,
	credentials: MountCredentials,
): Promise<DriveAnswer | null> {
	if (!(await allowMountCheck(env, user.id)))
		return fail(429, "Too many attempts. Wait a minute and try again.", "RATE_LIMITED");
	try {
		const root = await webdavClient(env, credentials).stat("/");
		if (root.kind !== "folder") return fail(400, "This address is a file, not a folder", "WEBDAV_NOT_FOLDER");
		return null;
	} catch (error) {
		if (!(error instanceof WebdavError)) throw error;
		const failure = webdavFailure(error);
		// On linking, everything the server or the address got wrong is the form's problem.
		return failure.status >= 500 ? { ...failure, status: 400 } : failure;
	}
}

/** The caller's own linked folder; anyone else's answers the same 404 as a missing one. */
export async function ownedMount(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveMountRow> {
	const [row] = await getDb(env)
		.select()
		.from(driveMounts)
		.where(and(eq(driveMounts.id, id), eq(driveMounts.ownerId, user.id)))
		.limit(1);
	if (!row) throw new DriveRefusal(404, "Not found");
	return row;
}

/** The row's credentials, opened; a restored row has none until its owner enters the password again. */
export async function mountCredentials(env: CloudflareEnv, row: DriveMountRow): Promise<MountCredentials> {
	const { url } = parseWebdavUrl(row.baseUrl);
	if (!url) throw new DriveRefusal(409, "This linked folder's address is no longer valid", "WEBDAV_INVALID");
	const password = await openSetting(env, row.password).catch(() => null);
	if (!password)
		throw new DriveRefusal(409, row.lastError ?? "Enter the app password for this folder again", "WEBDAV_AUTH");
	return { label: row.label, url, username: row.username, password };
}

/** Records whether the server last accepted the password, writing only when that changed. */
export async function recordMountStatus(
	env: CloudflareEnv,
	row: DriveMountRow,
	authFailed: boolean,
	message: string | null = null,
): Promise<void> {
	const status = authFailed ? "auth_failed" : "ok";
	if (row.status === status) return;
	await getDb(env)
		.update(driveMounts)
		.set({ status, lastError: authFailed ? message : null, updatedAt: new Date() })
		.where(eq(driveMounts.id, row.id));
}

/** `GET /api/drive/mounts`: the caller's linked folders, oldest first. */
export async function listMounts(env: CloudflareEnv, user: DriveUser): Promise<DriveAnswer> {
	const rows = await getDb(env)
		.select()
		.from(driveMounts)
		.where(eq(driveMounts.ownerId, user.id))
		.orderBy(asc(driveMounts.createdAt), asc(driveMounts.id));
	return ok({ mounts: rows.map(toMountDto), encryptionReady: !!env.APP_ENCRYPTION_KEY?.trim() });
}

/** `POST /api/drive/mounts` `{ label?, url, username, password }`: checked with a PROPFIND, then saved sealed. */
export async function createMount(env: CloudflareEnv, user: DriveUser, body: unknown): Promise<DriveAnswer> {
	if (!env.APP_ENCRYPTION_KEY?.trim()) return fail(409, ENCRYPTION_REQUIRED, "ENCRYPTION_REQUIRED");
	const parsed = parseMountCredentials(body, null);
	if ("error" in parsed) return fail(400, parsed.error, "INVALID_INPUT");
	const db = getDb(env);
	const [{ total }] = await db.select({ total: count() }).from(driveMounts).where(eq(driveMounts.ownerId, user.id));
	if (total >= MAX_MOUNTS_PER_USER) return fail(409, `You can link up to ${MAX_MOUNTS_PER_USER} folders`);
	const refused = await checkFolder(env, user, parsed);
	if (refused) return refused;
	const now = new Date();
	const row: DriveMountRow = {
		id: newId("dmt"),
		ownerId: user.id,
		kind: "webdav",
		label: parsed.label,
		baseUrl: parsed.url.href,
		username: parsed.username,
		password: await sealSetting(env, parsed.password),
		status: "ok",
		lastError: null,
		createdAt: now,
		updatedAt: now,
	};
	await db.insert(driveMounts).values(row);
	await createAuditLog(env, {
		actorUserId: user.id,
		action: "drive.mount_linked",
		metadata: { mountId: row.id, host: parsed.url.host },
	});
	log.info("drive.mount_linked", { mountId: row.id });
	return ok({ mount: toMountDto(row) }, 201);
}

/**
 * `PATCH /api/drive/mounts/[id]` `{ label?, url?, username?, password? }`: a new label alone is saved as is;
 * any change to the address or credentials (or a new password) is checked against the server first. An empty
 * password keeps the saved one.
 */
export async function updateMount(
	env: CloudflareEnv,
	user: DriveUser,
	id: string,
	body: unknown,
): Promise<DriveAnswer> {
	if (!env.APP_ENCRYPTION_KEY?.trim()) return fail(409, ENCRYPTION_REQUIRED, "ENCRYPTION_REQUIRED");
	const row = await ownedMount(env, user, id);
	const saved = await openSetting(env, row.password).catch(() => null);
	const parsed = parseMountCredentials(body, { ...row, password: saved || null });
	if ("error" in parsed) return fail(400, parsed.error, "INVALID_INPUT");
	const credentialsChanged =
		parsed.url.href !== row.baseUrl ||
		parsed.username !== row.username ||
		parsed.password !== saved ||
		row.status !== "ok";
	if (credentialsChanged) {
		const refused = await checkFolder(env, user, parsed);
		if (refused) return refused;
	}
	const next = {
		label: parsed.label,
		baseUrl: parsed.url.href,
		username: parsed.username,
		password: credentialsChanged ? await sealSetting(env, parsed.password) : row.password,
		status: "ok" as const,
		lastError: null,
		updatedAt: new Date(),
	};
	await getDb(env).update(driveMounts).set(next).where(eq(driveMounts.id, row.id));
	if (credentialsChanged)
		await createAuditLog(env, {
			actorUserId: user.id,
			action: "drive.mount_updated",
			metadata: { mountId: row.id, host: parsed.url.host },
		});
	return ok({ mount: toMountDto({ ...row, ...next }) });
}

/** `DELETE /api/drive/mounts/[id]`: unlinks the folder; nothing on the server is touched. */
export async function deleteMount(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveAnswer> {
	const row = await ownedMount(env, user, id);
	await getDb(env).delete(driveMounts).where(eq(driveMounts.id, row.id));
	await createAuditLog(env, { actorUserId: user.id, action: "drive.mount_unlinked", metadata: { mountId: row.id } });
	return ok({ ok: true });
}
