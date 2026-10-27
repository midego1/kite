import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import {
	readUserAiSettings,
	savePersonalInstructions,
	saveWritingStyleEnabled,
	UserAiSettingsPendingError,
} from "@/lib/agent/user-ai-settings";
import { deleteStyleProfiles, writingStyleAvailable } from "@/lib/agent/writing-style";
import type { UpdateAssistantSettingsInput } from "./types";
import { assistantSettingsResponse, parseUpdateAssistantSettingsRequest } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const ai = await readUserAiSettings(getDb(env), auth.user.id);
	return NextResponse.json(assistantSettingsResponse(auth.user.agentMaxSteps, ai, await writingStyleAvailable(env)));
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });

	let input: UpdateAssistantSettingsInput;
	try {
		input = await parseUpdateAssistantSettingsRequest(request);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof ZodError ? error.flatten() : "Invalid request" },
			{ status: 400 },
		);
	}

	const db = getDb(env);
	if (input.instructions) {
		try {
			await savePersonalInstructions(db, auth.user.id, input.instructions);
		} catch (error) {
			if (!(error instanceof UserAiSettingsPendingError)) throw error;
			return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
		}
	}
	const styleAvailable = await writingStyleAvailable(env);
	if (input.writingStyle) {
		if (!styleAvailable)
			return NextResponse.json(
				{ error: "Apply the pending database update to use the writing style profile", code: "MIGRATION_PENDING" },
				{ status: 409 },
			);
		await saveWritingStyleEnabled(db, auth.user.id, input.writingStyle.enabled);
		// Turning it off stops learning and using the profiles at once and deletes them.
		if (!input.writingStyle.enabled) await deleteStyleProfiles(db, auth.user.id);
	}
	let maxSteps = auth.user.agentMaxSteps;
	if (input.maxSteps !== undefined) {
		await db.update(users).set({ agentMaxSteps: input.maxSteps }).where(eq(users.id, auth.user.id));
		maxSteps = input.maxSteps;
	}
	return NextResponse.json(
		assistantSettingsResponse(maxSteps, await readUserAiSettings(db, auth.user.id), styleAvailable),
	);
}
