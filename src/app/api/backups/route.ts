import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getBackupConfigurationStatus } from "@/lib/backups/export";
import { runDatabaseBackup } from "@/lib/backups/runner";
import { createBackupRecord, getBackupSettings, listBackups, updateBackupSettings } from "@/lib/backups/service";
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
		await runDatabaseBackup(env, backupId);
		return NextResponse.json({ backupId });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to run backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
