import type { OnboardingChecklistItem, OnboardingChecklistState } from "./onboarding-checklist-types";

/**
 * The "Get started" checklist, in the order a new owner would reasonably do them. Each item's `done` comes from
 * real state (never from having opened the page), so it flips on its own as the owner sets things up elsewhere.
 */
export function onboardingChecklistItems(state: OnboardingChecklistState): OnboardingChecklistItem[] {
	return [
		{
			id: "domain",
			title: "Connect a domain",
			detail:
				"Mail for this domain is routed through Cloudflare Email Routing by default, or through Resend, Amazon SES or your own mail server. Every message is checked for spam and an unknown sender's first message is held by the Screener before it reaches the inbox.",
			href: "/domains",
			hrefLabel: "Open Domains",
			docHref: "providers.md",
			docLabel: "Sending and receiving providers",
			done: state.domainActive,
		},
		{
			id: "mailbox",
			title: "Create a mailbox",
			detail:
				"Each mailbox is its own inbox someone signs in to. A shared mailbox lets several people read and reply from the same address.",
			href: "/mailboxes",
			hrefLabel: "Open Mailboxes",
			done: state.mailboxCount > 0,
		},
		{
			id: "invite",
			title: "Invite your team",
			detail: "Add an account for each person who should sign in, then create a mailbox for them.",
			href: "/accounts",
			hrefLabel: "Open Accounts",
			done: state.accountCount > 1,
		},
		{
			id: "modules",
			title: "Review the modules",
			detail:
				"Calendar, Booking, Email templates, Mail import, Money Watch and Drive can each be turned off for the whole install or for one person. Turning one off hides it; it never deletes its data.",
			href: "/modules",
			hrefLabel: "Open Modules",
			docHref: "modules.md#what-off-does",
			docLabel: "What off does",
			done: state.modulesConfigured,
		},
		{
			id: "spam",
			title: "Turn on phishing and malware lookups",
			detail:
				"A free abuse.ch key lets Kite check risky links and attachments against the URLhaus and ThreatFox threat lists; those two outside services are the only thing a key sends mail data to. Kite's own spam and phishing filters run either way.",
			href: "/general#threat-lookups",
			hrefLabel: "Open General",
			docHref: "spam-protection.md#urlhaus-and-threatfox-lookups-optional",
			docLabel: "URLhaus and ThreatFox lookups",
			done: state.spamKeyConfigured,
		},
		{
			id: "assistant",
			title: "Connect an AI provider",
			detail:
				"Kite's assistant can triage mail, draft replies and find subscriptions once an AI provider is connected and tested. Mail only leaves this install when the assistant is on, and only to the provider chosen here.",
			href: "/agent#ai-provider",
			hrefLabel: "Open Agent",
			docHref: "assistant.md#ai-providers",
			docLabel: "AI providers",
			done: state.assistantConfigured,
		},
		{
			id: "backups",
			title: "Turn on backups",
			detail: "A daily backup protects the database if something goes wrong. Turn on automatic backups or run one now.",
			href: "/backups",
			hrefLabel: "Open Backups",
			docHref: "operations.md#full-backups",
			docLabel: "Full backups",
			done: state.backupsReady,
		},
		{
			id: "updates",
			title: "Keep the database up to date",
			detail:
				"A release sometimes needs a database update. Apply a pending one so new mail keeps appearing and every page keeps working.",
			href: "/admin#database",
			hrefLabel: "Open the database update",
			done: state.migrationsPending === 0,
		},
	];
}
