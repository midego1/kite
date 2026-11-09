import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import {
	assistantEmailSettingsReady,
	readUserAiSettings,
	saveAssistantEmailSettings,
	savePersonalInstructions,
	saveWritingStyleEnabled,
	UserAiSettingsPendingError,
} from "@/lib/agent/user-ai-settings";
import { deleteStyleProfiles, writingStyleAvailable } from "@/lib/agent/writing-style";
import type { UpdateAssistantSettingsInput } from "./types";
import { assistantSettingsResponse, parseUpdateAssistantSettingsRequest } from "./utils";

async function personalMailboxOptions(env: ReturnType<typeof getEnv>, userId: string) {
	const rows = await getDb(env)
		.select({ id: mailboxes.id, localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.type, "personal"), eq(mailboxes.disabled, false)))
		// Oldest first, with the same tiebreak intake uses, so the first option is the mailbox it falls back to.
		.orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));
	return rows.map((row) => ({ id: row.id, label: `${row.localPart}@${row.hostname}` }));
}

/** Whether `mailboxId` is one of the user's own personal mailboxes (never a shared one — spec §5.3). */
async function ownsPersonalMailbox(
	env: ReturnType<typeof getEnv>,
	userId: string,
	mailboxId: string,
): Promise<boolean> {
	const [row] = await getDb(env)
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(
			and(
				eq(mailboxes.id, mailboxId),
				eq(mailboxes.userId, userId),
				eq(mailboxes.type, "personal"),
				eq(mailboxes.disabled, false),
			),
		)
		.limit(1);
	return !!row;
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const ai = await readUserAiSettings(getDb(env), auth.user.id);
	return NextResponse.json(
		assistantSettingsResponse(auth.user.agentMaxSteps, ai, await writingStyleAvailable(env), {
			ready: await assistantEmailSettingsReady(env),
			mailboxes: await personalMailboxOptions(env, auth.user.id),
		}),
	);
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
	// Everything that can be refused is checked before anything is saved, so a rejected request changes nothing.
	if (
		input.emailAssistant?.mailboxId !== undefined &&
		!(await ownsPersonalMailbox(env, auth.user.id, input.emailAssistant.mailboxId))
	)
		return NextResponse.json({ error: "Mailbox not found" }, { status: 400 });
	const styleAvailable = await writingStyleAvailable(env);
	if (input.writingStyle && !styleAvailable)
		return NextResponse.json(
			{ error: "Apply the pending database update to use the writing style profile", code: "MIGRATION_PENDING" },
			{ status: 409 },
		);
	if (input.instructions) {
		try {
			await savePersonalInstructions(db, auth.user.id, input.instructions);
		} catch (error) {
			if (!(error instanceof UserAiSettingsPendingError)) throw error;
			return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
		}
	}
	if (input.writingStyle) {
		await saveWritingStyleEnabled(db, auth.user.id, input.writingStyle.enabled);
		// Turning it off stops learning and using the profiles at once and deletes them.
		if (!input.writingStyle.enabled) await deleteStyleProfiles(db, auth.user.id);
	}
	if (input.emailAssistant) {
		try {
			await saveAssistantEmailSettings(db, auth.user.id, input.emailAssistant);
		} catch (error) {
			if (!(error instanceof UserAiSettingsPendingError)) throw error;
			return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
		}
	}
	let maxSteps = auth.user.agentMaxSteps;
	if (input.maxSteps !== undefined) {
		await db.update(users).set({ agentMaxSteps: input.maxSteps }).where(eq(users.id, auth.user.id));
		maxSteps = input.maxSteps;
	}
	return NextResponse.json(
		assistantSettingsResponse(maxSteps, await readUserAiSettings(db, auth.user.id), styleAvailable, {
			ready: await assistantEmailSettingsReady(env),
			mailboxes: await personalMailboxOptions(env, auth.user.id),
		}),
	);
}
