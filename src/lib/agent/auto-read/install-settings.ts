import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { getDb } from "@/db";
import { agentJobs, appSettings } from "@/db/schema";
import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { insertRow, selectRow } from "@/lib/db/pending-columns";
import { aiWritingMigrationApplied } from "../ai-writing-migration";
import type { AutoReadInstallSettings } from "./settings-types";
import { DEFAULT_INSTALL_SPEND_CAP_MICROS, type autoReadAdminSchema } from "./settings-utils";
import { UNKNOWN_RATES_INPUT_TOKEN_CAP } from "./spend-utils";

/**
 * The install-wide assistant settings. The whole row goes through `selectRow`, so the token allowances read as
 * their defaults on a database that has not applied migration 0069 yet.
 */
export async function getAutoReadInstallSettings(env: CloudflareEnv): Promise<AutoReadInstallSettings> {
	const saved = await selectRow(getDb(env), appSettings, eq(appSettings.id, AGENT_SETTINGS_ID));
	if (!saved)
		return {
			agentEnabled: true,
			autoReadEnabled: true,
			externalAutoReadAllowed: false,
			dailySpendCapMicros: DEFAULT_INSTALL_SPEND_CAP_MICROS,
			autoReadTokenCap: UNKNOWN_RATES_INPUT_TOKEN_CAP,
			chatTokenCap: UNKNOWN_RATES_INPUT_TOKEN_CAP,
		};
	return {
		agentEnabled: saved.agentEnabled,
		autoReadEnabled: saved.agentAutoReadEnabled,
		externalAutoReadAllowed: saved.agentExternalAutoReadAllowed,
		dailySpendCapMicros: saved.agentDailySpendCapMicros,
		autoReadTokenCap: saved.agentAutoReadTokenCap,
		chatTokenCap: saved.agentChatTokenCap,
	};
}

/** The install-wide fields the primary admin sees; Full auto stays internal until it ships. */
export async function getAutoReadAdminSettings(env: CloudflareEnv) {
	const install = await getAutoReadInstallSettings(env);
	const { autoReadEnabled, externalAutoReadAllowed, dailySpendCapMicros, autoReadTokenCap, chatTokenCap } = install;
	return {
		autoReadEnabled,
		externalAutoReadAllowed,
		dailySpendCapMicros,
		autoReadTokenCap,
		chatTokenCap,
		tokenCapsReady: await aiWritingMigrationApplied(env),
	};
}

/** Saving a token allowance before migration 0069; the admin route answers 409 `MIGRATION_PENDING`. */
export class TokenCapsPendingError extends Error {
	constructor() {
		super("Apply the pending database update to change the token allowances");
		this.name = "TokenCapsPendingError";
	}
}

/**
 * Saves the admin's changes. The row is created with `insertRow` and then updated with only the changed columns,
 * so the other settings still save before migration 0069; a token allowance then throws `TokenCapsPendingError`.
 */
export async function saveAutoReadAdminSettings(env: CloudflareEnv, input: z.infer<typeof autoReadAdminSchema>) {
	const values = {
		...(input.autoReadEnabled === undefined ? {} : { agentAutoReadEnabled: input.autoReadEnabled }),
		...(input.externalAutoReadAllowed === undefined
			? {}
			: { agentExternalAutoReadAllowed: input.externalAutoReadAllowed }),
		...(input.dailySpendCapMicros === undefined ? {} : { agentDailySpendCapMicros: input.dailySpendCapMicros }),
		...(input.autoReadTokenCap === undefined ? {} : { agentAutoReadTokenCap: input.autoReadTokenCap }),
		...(input.chatTokenCap === undefined ? {} : { agentChatTokenCap: input.chatTokenCap }),
	};
	const db = getDb(env);
	await insertRow(db, appSettings, { id: AGENT_SETTINGS_ID }, { ignoreConflict: true });
	try {
		await db
			.update(appSettings)
			.set({ ...values, updatedAt: new Date() })
			.where(eq(appSettings.id, AGENT_SETTINGS_ID));
	} catch (error) {
		const column = missingColumnFromError(error);
		if (column === "agent_auto_read_token_cap" || column === "agent_chat_token_cap") throw new TokenCapsPendingError();
		throw error;
	}
	if (input.autoReadEnabled === false)
		await db
			.update(agentJobs)
			.set({ status: "skipped", reason: "kill_switch" })
			.where(and(eq(agentJobs.status, "pending"), eq(agentJobs.kind, "triage")));
}

export async function skipPendingMailboxJobs(
	env: CloudflareEnv,
	mailboxId: string,
	kind: "draft" | "triage" | "line_summary",
	reason: string,
) {
	await getDb(env)
		.update(agentJobs)
		.set({ status: "skipped", reason })
		.where(and(eq(agentJobs.mailboxId, mailboxId), eq(agentJobs.status, "pending"), eq(agentJobs.kind, kind)));
}
