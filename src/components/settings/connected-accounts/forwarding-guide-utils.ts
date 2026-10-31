import type { ExternalAccountPresetId } from "@/lib/external-accounts/types";

/** A provider in the forwarding guide (spec §6.1: forwarding first, no stored password). */
export type ForwardingProviderId = "gmail" | "microsoft" | "icloud" | "yahoo" | "fastmail" | "other";

/** One step; `{address}` is replaced by the Kite address mail should go to. */
export type ForwardingProvider = {
	id: ForwardingProviderId;
	name: string;
	/** Where the provider's own forwarding settings are, opened in a new tab. */
	settings: { label: string; url: string }[];
	/** The provider's help page on forwarding. */
	help: string | null;
	steps: string[];
	/** What can stop forwarding at this provider, said before the steps. */
	notes: string[];
};

export const FORWARDING_PROVIDERS: readonly ForwardingProvider[] = [
	{
		id: "gmail",
		name: "Gmail",
		settings: [
			{ label: "Open Gmail's forwarding settings", url: "https://mail.google.com/mail/u/0/#settings/fwdandpop" },
		],
		help: "https://support.google.com/mail/answer/10957",
		steps: [
			"In Gmail on the web, open Settings → See all settings → Forwarding and POP/IMAP.",
			"Choose Add a forwarding address, enter {address} and choose Next → Proceed. Gmail mails a confirmation code to that address.",
			"The confirmation arrives in Kite. Open it and follow its link, or type its code into Gmail.",
			'Back in Gmail, choose "Forward a copy of incoming mail to" {address}, keep Gmail\'s copy in the Inbox and choose Save Changes.',
		],
		notes: [
			"Google Workspace works the same way, unless your admin turned off automatic forwarding.",
			"Gmail does not forward mail it filed as spam.",
		],
	},
	{
		id: "microsoft",
		name: "Outlook.com and Microsoft 365",
		settings: [
			{ label: "Open Outlook.com forwarding", url: "https://outlook.live.com/mail/0/options/mail/forwarding" },
			{ label: "Open Microsoft 365 forwarding", url: "https://outlook.office.com/mail/options/mail/forwarding" },
		],
		help: "https://support.microsoft.com/office/6246987c-6c8f-4144-b255-14fc07007dad",
		steps: [
			"In Outlook on the web, open Settings → Mail → Forwarding.",
			"Turn on Enable forwarding and enter {address}.",
			"Turn on Keep a copy of forwarded messages, then choose Save.",
		],
		notes: [
			"Kite cannot connect Outlook.com, Hotmail or Microsoft 365 accounts yet (they sign in only with Microsoft's own sign-in), so forwarding is the way to bring their mail in.",
			"Outlook.com may ask you to turn on two-step verification first.",
			'Many Microsoft 365 organisations block forwarding to outside addresses: forwarded mail then bounces with "Your organization does not allow external forwarding". Ask your admin to allow it for your mailbox.',
		],
	},
	{
		id: "icloud",
		name: "iCloud Mail",
		settings: [{ label: "Open iCloud Mail", url: "https://www.icloud.com/mail" }],
		help: "https://support.apple.com/guide/icloud/mm6b1a3960/icloud",
		steps: [
			"Open iCloud Mail on icloud.com and sign in.",
			"Choose the settings button at the top of the mailbox list, then Settings → Mail Forwarding.",
			'Select "Forward my email to" and enter {address}. Leave "Delete messages after forwarding" off, so iCloud keeps its copy.',
			"Choose Done.",
		],
		notes: [],
	},
	{
		id: "yahoo",
		name: "Yahoo Mail",
		settings: [{ label: "Open Yahoo Mail", url: "https://mail.yahoo.com/" }],
		help: "https://help.yahoo.com/kb/SLN29133.html",
		steps: [
			"In Yahoo Mail on the web, open Settings → More Settings → Mailboxes.",
			"Choose your Yahoo address under Mailbox list.",
			"Under Forwarding, enter {address} and choose Verify. Yahoo mails a link to that address; open it in Kite and confirm.",
			"Choose Store and forward, then Save.",
		],
		notes: [
			"Yahoo offers automatic forwarding only with Yahoo Mail Plus. On a free account, connect the account instead.",
		],
	},
	{
		id: "fastmail",
		name: "Fastmail",
		settings: [{ label: "Open Fastmail mail rules", url: "https://app.fastmail.com/settings/rules" }],
		help: "https://www.fastmail.help/hc/en-us/articles/360058753434",
		steps: [
			"In Fastmail, open Settings → Mail rules and choose Create rule.",
			"Choose All messages as the condition, then Continue.",
			'Choose the action "Send a copy to", enter {address} and choose Save.',
		],
		notes: [],
	},
	{
		id: "other",
		name: "Other providers",
		settings: [],
		help: null,
		steps: [
			"In your provider's webmail, open its settings and look for Forwarding, Auto-forward or Mail rules.",
			"Forward all incoming mail to {address}, keeping a copy at the provider.",
			"If the provider asks you to confirm the address, its confirmation arrives in Kite: open it there.",
		],
		notes: [
			"No forwarding setting, or it is blocked? Connect the account instead: Kite then checks its Inbox every few minutes.",
		],
	},
];

/** What to check once forwarding is on, for every provider. */
export const FORWARDING_CHECKS: readonly string[] = [
	"Send a test message from another address to the account (mail you send to yourself is often not forwarded). It should be in Kite within a minute.",
	"Nothing arrived? Look in Spam and the Screener. Forwarded mail fails the original sender's SPF check, so Kite relies on DKIM and ARC; most mail from large senders still passes.",
	"Optional: a mailbox rule (Settings → Rules) that files mail whose To is the account's address into a folder keeps it apart.",
	"Do not also connect the same account: Kite does not compare forwarded mail with synced mail, so every message would arrive twice.",
];

/** The guide's tab for a connect-dialog provider; Google Workspace forwards like Gmail, AOL like any other. */
export function forwardingProviderFor(preset: ExternalAccountPresetId): ForwardingProviderId {
	if (preset === "google_workspace") return "gmail";
	if (preset === "aol") return "other";
	return preset;
}

/** A step with the Kite address filled in, split so the address can be shown as code. */
export function forwardingStepParts(step: string, address: string): { text: string; address: boolean }[] {
	return step
		.split("{address}")
		.flatMap((text, index) =>
			index === 0
				? [{ text, address: false }]
				: [
						{ text: address, address: true },
						{ text, address: false },
					],
		)
		.filter((part) => part.text);
}
