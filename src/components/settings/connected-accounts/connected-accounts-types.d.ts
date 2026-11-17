import type {
	ConnectRefusal,
	ExternalAccountPresetId,
	ExternalAccountView,
	MailServerSettings,
	OAuthProviders,
} from "@/lib/external-accounts/types";

export type PresetOption = {
	id: ExternalAccountPresetId;
	label: string;
	imap: MailServerSettings;
	smtp: MailServerSettings;
	passwordSignIn: boolean;
	passwordHelp: string;
};

export type ConnectedAccountsState = {
	accounts: ExternalAccountView[];
	refusal: ConnectRefusal | null;
	refusalText: string | null;
	presets: PresetOption[];
	/** Provider sign-ins the owner set up (Sign in with Microsoft or Google); absent from an older server. */
	oauth?: OAuthProviders;
	migrationPending: boolean;
};

/** The connect and edit form; numbers stay strings while typed. */
export type AccountFormState = {
	address: string;
	preset: ExternalAccountPresetId;
	label: string;
	mailboxId: string;
	username: string;
	password: string;
	kitePassword: string;
	imapHost: string;
	imapPort: string;
	imapSecurity: "tls" | "starttls";
	smtpHost: string;
	smtpPort: string;
	smtpSecurity: "tls" | "starttls";
	/** How often Kite checks for new mail: "5", "15" or "60". */
	syncIntervalMinutes: string;
};
