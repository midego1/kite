const primaryOnlyPrefixes = [
	"/agent",
	"/api-keys",
	"/webhooks",
	"/backups",
	"/branding",
	"/activity",
	"/audit-logs",
	"/general",
	"/ai-usage",
	"/alerts",
];

/** Whether an admin route is open to the primary admin only. */
export function requiresPrimaryAdmin(pathname: string): boolean {
	return primaryOnlyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
