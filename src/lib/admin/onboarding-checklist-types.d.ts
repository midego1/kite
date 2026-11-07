/** The real state behind each checklist item (`loadOnboardingChecklistState`). */
export type OnboardingChecklistState = {
	/** Any domain is active: Cloudflare Email Routing confirmed it, or DNS setup was deliberately skipped. */
	domainActive: boolean;
	mailboxCount: number;
	accountCount: number;
	/** At least one module's install-wide switch was explicitly changed from its default. */
	modulesConfigured: boolean;
	/** `resolveAbuseChKey` found a usable key, either a secret or one saved and tested on the General page. */
	spamKeyConfigured: boolean;
	/** The assistant is deliberately off, or a saved AI provider is active. */
	assistantConfigured: boolean;
	/** Automatic backups are on, or at least one backup has already completed. */
	backupsReady: boolean;
	migrationsPending: number;
};

export type OnboardingChecklistItemId =
	"domain" | "mailbox" | "invite" | "modules" | "spam" | "assistant" | "backups" | "updates";

/** One step of the "Get started" checklist (`onboardingChecklistItems`). */
export type OnboardingChecklistItem = {
	id: OnboardingChecklistItemId;
	title: string;
	detail: string;
	href: string;
	hrefLabel: string;
	docHref?: string;
	docLabel?: string;
	done: boolean;
};

/** What `GET`/`PATCH /api/admin/onboarding-checklist` answer. */
export type OnboardingChecklistResponse = {
	dismissed: boolean;
	items: OnboardingChecklistItem[];
};
