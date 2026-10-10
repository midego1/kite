import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { getDb } from "@/db";
import { agentJobs, appSettings } from "@/db/schema";
import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import type { AutoReadInstallSettings } from "./settings-types";
import { DEFAULT_INSTALL_SPEND_CAP_MICROS, type autoReadAdminSchema } from "./settings-utils";

export async function getAutoReadInstallSettings(env: CloudflareEnv): Promise<AutoReadInstallSettings> {
	const [saved] = await getDb(env)
		.select({
			agentEnabled: appSettings.agentEnabled,
			autoReadEnabled: appSettings.agentAutoReadEnabled,
			externalAutoReadAllowed: appSettings.agentExternalAutoReadAllowed,
			dailySpendCapMicros: appSettings.agentDailySpendCapMicros,
		})
		.from(appSettings)
		.where(eq(appSettings.id, AGENT_SETTINGS_ID))
		.limit(1);
	return (
		saved ?? {
			agentEnabled: true,
			autoReadEnabled: true,
			externalAutoReadAllowed: false,
			dailySpendCapMicros: DEFAULT_INSTALL_SPEND_CAP_MICROS,
		}
	);
}

/** The install-wide fields the primary admin sees; Full auto stays internal until it ships. */
export async function getAutoReadAdminSettings(env: CloudflareEnv) {
	const { autoReadEnabled, externalAutoReadAllowed, dailySpendCapMicros } = await getAutoReadInstallSettings(env);
	return { autoReadEnabled, externalAutoReadAllowed, dailySpendCapMicros };
}

export async function saveAutoReadAdminSettings(env: CloudflareEnv, input: z.infer<typeof autoReadAdminSchema>) {
	const values = {
		...(input.autoReadEnabled === undefined ? {} : { agentAutoReadEnabled: input.autoReadEnabled }),
		...(input.externalAutoReadAllowed === undefined
			? {}
			: { agentExternalAutoReadAllowed: input.externalAutoReadAllowed }),
		...(input.dailySpendCapMicros === undefined ? {} : { agentDailySpendCapMicros: input.dailySpendCapMicros }),
	};
	const db = getDb(env);
	await db
		.insert(appSettings)
		.values({ id: AGENT_SETTINGS_ID, ...values })
		.onConflictDoUpdate({ target: appSettings.id, set: { ...values, updatedAt: new Date() } });
	if (input.autoReadEnabled === false)
		await db
			.update(agentJobs)
			.set({ status: "skipped", reason: "kill_switch" })
			.where(and(eq(agentJobs.status, "pending"), eq(agentJobs.kind, "triage")));
}

export async function skipPendingMailboxJobs(
	env: CloudflareEnv,
	mailboxId: string,
	kind: "draft" | "triage",
	reason: string,
) {
	await getDb(env)
		.update(agentJobs)
		.set({ status: "skipped", reason })
		.where(and(eq(agentJobs.mailboxId, mailboxId), eq(agentJobs.status, "pending"), eq(agentJobs.kind, kind)));
}
