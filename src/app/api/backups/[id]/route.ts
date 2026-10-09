import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { deleteBackup } from "@/lib/backups/service";
import { getEnv } from "@/lib/cloudflare";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	try {
		const { id } = await params;
		const deleted = await deleteBackup(env, id);
		if (!deleted) return NextResponse.json({ error: "Backup not found" }, { status: 404 });
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}
