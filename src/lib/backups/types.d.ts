export type BackupScheduleType = "daily" | "weekly" | "monthly";
export type BackupTableGroupId = "accounts" | "mail" | "drive" | "automation" | "assistant" | "system";

export type DatabaseBackupTable =
	| "users"
	| "domains"
	| "mailboxes"
	| "mailbox_access"
	| "contacts"
	| "folders"
	| "api_keys"
	| "messages"
	| "message_attachments"
	| "shared_attachment_links"
	| "outbound_jobs"
	| "routing_rules"
	| "webhooks"
	| "webhook_deliveries"
	| "sessions"
	| "audit_logs"
	| "backup_settings"
	| "backups"
	| "storage_stores"
	| "storage_routes"
	| "app_settings"
	| "module_settings"
	| "user_module_access"
	| "booking_appointments"
	| "finance_subscriptions"
	| "finance_charges"
	| "drive_items"
	| "drive_shares"
	| "drive_links"
	| "drive_settings"
	| "drive_user_quotas"
	| "email_templates"
	| "calendar_events"
	| "booking_events"
	| "auto_reply_deliveries"
	| "spam_token_stats"
	| "spam_reputation"
	| "spam_feedback"
	| "screener_settings"
	| "screener_senders"
	| "mailbox_aliases"
	| "password_reset_tokens"
	| "mfa_recovery_codes"
	| "login_challenges"
	| "mailbox_agent_settings"
	| "user_ai_settings"
	| "writing_style_profiles"
	| "composer_sends"
	| "ai_assisted_drafts"
	| "agent_conversations"
	| "agent_chat_messages"
	| "agent_jobs"
	| "agent_draft_metadata"
	| "agent_send_approvals"
	| "agent_suggestions"
	| "agent_actions"
	| "agent_sender_policies"
	| "mcp_key_mailboxes"
	| "ai_usage";
export type DatabaseRecord = Record<string, string | number | null>;
export type DatabaseBackupDocument = {
	/** Backups written before the rename to Kite carry "mailflare-database-backup". */
	format: "kite-database-backup" | "mailflare-database-backup";
	version: 1;
	createdAt: string;
	includedTables?: DatabaseBackupTable[];
	/** Written since the drive group; documents without it predate every group added after LEGACY_BACKUP_TABLE_GROUPS. */
	excludedGroups?: BackupTableGroupId[];
	tables: Partial<Record<DatabaseBackupTable, DatabaseRecord[]>>;
};
