import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getBackupConfigurationStatus } from "@/lib/backups/export";
import { backupRunMessage } from "@/lib/backups/queue-utils";
import {
	createBackupRecord,
	failBackupRecord,
	failStaleBackups,
	getBackupSettings,
	listBackups,
	updateBackupSettings,
} from "@/lib/backups/service";
import { getEnv } from "@/lib/cloudflare";
import { parseBackupSettingsInput } from "./utils";

function requireAdmin(env: CloudflareEnv, request: Request) {
	return requireSessionAdmin(env, request, isPrimaryAdmin);
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireAdmin(env, request);
	if (auth.error) return auth.error;
	try {
		// A backup whose invocation was killed would otherwise stay "running" here
		// forever; listing is where the admin page notices and heals it.
		await failStaleBackups(env);
		const [settings, backupList] = await Promise.all([getBackupSettings(env), listBackups(env)]);
		return NextResponse.json({
			settings,
			backups: backupList,
			configuration: getBackupConfigurationStatus(env),
		});
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}

export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireAdmin(env, request);
	if (auth.error) return auth.error;
	try {
		const input = parseBackupSettingsInput(await request.json());
		if (!input) return NextResponse.json({ error: "Invalid backup settings" }, { status: 400 });
		await updateBackupSettings(env, input);
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireAdmin(env, request);
	if (auth.error) return auth.error;
	try {
		const backupId = await createBackupRecord(env, "manual", auth.user.id);
		try {
			// The export runs on the queue consumer, not here: on a large database it
			// outlives the response timeout, and a cancelled invocation used to leave
			// the record "running" with no file and no way to delete it.
			await env.OUTBOUND_QUEUE.send(backupRunMessage(backupId));
		} catch (error) {
			await failBackupRecord(env, backupId, error instanceof Error ? error.message : "Could not queue the backup");
			throw error;
		}
		return NextResponse.json({ backupId, status: "queued" }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to run backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
