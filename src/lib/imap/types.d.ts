import type { MailSocketSecurity } from "@/lib/net/types";

export type ImapLogin = {
	host: string;
	port: number;
	security: MailSocketSecurity;
	username: string;
	password: string;
};

export type ImapTlsPlan = { action: "none" } | { action: "starttls" } | { action: "refuse"; reason: string };

export type ImapAuthMethod = "plain-ir" | "plain" | "login";
