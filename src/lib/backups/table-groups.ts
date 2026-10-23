import type { BackupTableGroupId, DatabaseBackupTable } from "./types";

export const BACKUP_TABLE_GROUPS: { id: BackupTableGroupId; label: string; tables: DatabaseBackupTable[] }[] = [
	{
		id: "accounts",
		label: "Accounts and mailboxes",
		tables: [
			"users",
			"domains",
			"mailboxes",
			"mailbox_access",
			"mailbox_aliases",
			"contacts",
			"api_keys",
			"mcp_key_mailboxes",
			"sessions",
			"password_reset_tokens",
			"mfa_recovery_codes",
			"login_challenges",
			"user_module_access",
			"booking_appointments",
		],
	},
	{
		id: "mail",
		label: "Mail and related data",
		tables: [
			"folders",
			"messages",
			"message_attachments",
			"shared_attachment_links",
			"outbound_jobs",
			"email_templates",
			"calendar_events",
			"booking_events",
			"finance_subscriptions",
			"finance_charges",
			"auto_reply_deliveries",
			"spam_token_stats",
			"spam_reputation",
			"spam_feedback",
			"screener_settings",
			"screener_senders",
		],
	},
	{
		id: "drive",
		label: "Drive files and sharing",
		tables: ["drive_items", "drive_shares", "drive_links", "drive_settings", "drive_user_quotas"],
	},
	{ id: "automation", label: "Routing and webhooks", tables: ["routing_rules", "webhooks", "webhook_deliveries"] },
	{
		id: "assistant",
		label: "Assistant and AI usage",
		tables: [
			"mailbox_agent_settings",
			"agent_conversations",
			"agent_chat_messages",
			"agent_jobs",
			"agent_draft_metadata",
			"agent_send_approvals",
			"agent_suggestions",
			"agent_actions",
			"agent_sender_policies",
			"ai_usage",
		],
	},
	{
		id: "system",
		label: "App settings and history",
		tables: [
			"audit_logs",
			"backup_settings",
			"backups",
			"storage_stores",
			"storage_routes",
			"app_settings",
			"module_settings",
		],
	},
];

/**
 * The groups that existed before backup documents recorded `excludedGroups`.
 * A document without that field can only prove it is complete for these, so a
 * group added later (drive onwards) may be absent from an older full backup.
 */
const LEGACY_BACKUP_TABLE_GROUPS: BackupTableGroupId[] = ["accounts", "mail", "automation", "assistant", "system"];

/** Whether a document leaves out a group its writer knew about, which restore refuses. */
export function isPartialBackupDocument(document: {
	includedTables?: DatabaseBackupTable[];
	excludedGroups?: BackupTableGroupId[];
}): boolean {
	const included = document.includedTables;
	if (!included) return false;
	if (document.excludedGroups) return document.excludedGroups.length > 0;
	return BACKUP_TABLE_GROUPS.some(
		(group) => LEGACY_BACKUP_TABLE_GROUPS.includes(group.id) && !group.tables.some((table) => included.includes(table)),
	);
}

export function getSelectedBackupTables(excludedGroups: BackupTableGroupId[]): Set<DatabaseBackupTable> {
	const excluded = new Set(excludedGroups);
	return new Set(BACKUP_TABLE_GROUPS.filter((group) => !excluded.has(group.id)).flatMap((group) => group.tables));
}

export function parseExcludedBackupTableGroups(value: string): BackupTableGroupId[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		const known = new Set(BACKUP_TABLE_GROUPS.map((group) => group.id));
		return parsed.filter(
			(group): group is BackupTableGroupId => typeof group === "string" && known.has(group as BackupTableGroupId),
		);
	} catch {
		return [];
	}
}
