const ACRONYMS: Record<string, string> = {
	ai: "AI",
	api: "API",
	dns: "DNS",
	dmarc: "DMARC",
	fts: "FTS",
	id: "ID",
	imap: "IMAP",
	jmap: "JMAP",
	mfa: "MFA",
	mcp: "MCP",
	s3: "S3",
	ses: "SES",
	smtp: "SMTP",
	ui: "UI",
	url: "URL",
};

/**
 * A migration file name in words for the owner: `0092_add_mailbox_ai_disabled_at.sql` reads
 * "Add mailbox AI disabled at". The file name stays available beside it; a name that is not a numbered
 * migration is returned as it is.
 */
export function migrationLabel(name: string): string {
	const match = /^\d+_([a-z0-9][a-z0-9_]*?)(?:\.sql)?$/.exec(name);
	if (!match) return name;
	const words = match[1].split("_").filter(Boolean);
	if (!words.length) return name;
	const label = words.map((word) => ACRONYMS[word] ?? word).join(" ");
	return label.charAt(0).toUpperCase() + label.slice(1);
}
