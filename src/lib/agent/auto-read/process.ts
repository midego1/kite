import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentJobs, mailboxAgentSettings, messages } from "@/db/schema";
import { claimAgentJob, failAgentJob, skipAgentJob } from "../jobs/lease";
import { getAutoReadInstallSettings } from "./install-settings";
import { isPaused } from "./schedule-utils";

async function triageSkipReason(env: CloudflareEnv, mailboxId: string, sourceMessageId: string) {
	const install = await getAutoReadInstallSettings(env);
	if (!install.agentEnabled) return "assistant_disabled";
	if (!install.autoReadEnabled) return "kill_switch";
	const db = getDb(env);
	const [settings] = await db
		.select({ autonomy: mailboxAgentSettings.autonomy, pausedUntil: mailboxAgentSettings.pausedUntil })
		.from(mailboxAgentSettings)
		.where(eq(mailboxAgentSettings.mailboxId, mailboxId))
		.limit(1);
	if (!settings || settings.autonomy === "off") return "autonomy_off";
	if (isPaused(settings.pausedUntil)) return "paused";
	const [source] = await db
		.select({ status: messages.status })
		.from(messages)
		.where(eq(messages.id, sourceMessageId))
		.limit(1);
	if (source?.status !== "received") return "source_changed";
	return null;
}

export async function processAgentTriageJob(env: CloudflareEnv, jobId: string) {
	const db = getDb(env);
	const job = await claimAgentJob(db, jobId);
	if (!job) return;
	try {
		const reason = await triageSkipReason(env, job.mailboxId, job.sourceMessageId);
		if (reason) return void (await skipAgentJob(db, jobId, reason));
		await db.update(agentJobs).set({ status: "completed", leaseUntil: null }).where(eq(agentJobs.id, jobId));
	} catch (error) {
		await failAgentJob(db, job, error);
	}
}
