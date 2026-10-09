import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import type { SendingSettingsResponse, UpdateSendingSettingsInput } from "./types";
import { parseUpdateSendingSettingsRequest } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return NextResponse.json({
		previewEnabled: auth.user.sendPreviewEnabled,
		undoSeconds: auth.user.undoSendSeconds,
	} satisfies SendingSettingsResponse);
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	let input: UpdateSendingSettingsInput;
	try {
		input = await parseUpdateSendingSettingsRequest(request);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof ZodError ? error.flatten() : "Invalid request" },
			{ status: 400 },
		);
	}

	const next: SendingSettingsResponse = {
		previewEnabled: input.previewEnabled ?? auth.user.sendPreviewEnabled,
		undoSeconds: input.undoSeconds ?? auth.user.undoSendSeconds,
	};
	await getDb(env)
		.update(users)
		.set({ sendPreviewEnabled: next.previewEnabled, undoSendSeconds: next.undoSeconds })
		.where(eq(users.id, auth.user.id));

	return NextResponse.json(next);
}
