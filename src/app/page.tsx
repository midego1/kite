import type { Metadata } from "next";
import { getHomeBranding } from "./home-server-utils";
import { HomeAuthProvider } from "./home-auth";
import { HomeChrome } from "./home-chrome";
import { HEADLINE } from "./home-content";
import { buildHomeEmails } from "./home-emails";
import { HomeMailbox } from "./home-mailbox";
import { SidebarFooter } from "./home-sidebar-footer";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
	const branding = await getHomeBranding();
	return {
		title: branding.appName,
		description: `${branding.appName} is a self-hosted webmail app on Cloudflare Workers. It receives through Email Routing and sends through Cloudflare, Resend or Amazon SES. Your mail stays in your D1 database and R2 bucket (SQLite and local files with Docker). Every feature is free. Early beta.`,
		keywords: [
			"cloudflare",
			"cloudflare-workers",
			"d1",
			"email",
			"email-client",
			"jmap",
			"nextjs",
			"r2",
			"self-hosted",
			"webmail",
		],
		icons: { icon: branding.hasCustomIcon ? "/api/branding/icon" : "/icon-96.png" },
	};
}

/*
 * The home page is the product: a full-viewport mailbox whose folders are the site's navigation and whose emails
 * are its content (home-emails.tsx). The server renders every email into the page, so the Welcome email reads
 * without JavaScript and each email's headings are in the HTML; the client shell (home-mailbox.tsx) shows one at
 * a time. The page never scrolls. It follows the app's own theme and look, and nothing it sets reaches the app.
 */
export default async function HomePage() {
	const branding = await getHomeBranding();
	const icon = branding.hasCustomIcon ? "/api/branding/icon" : "/kite.svg";
	const { metas, bodies } = buildHomeEmails(branding.appName);

	return (
		<HomeAuthProvider>
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-neutral-900 focus:shadow"
			>
				Skip to the message
			</a>
			<HomeMailbox
				appName={branding.appName}
				icon={icon}
				emails={metas}
				bodies={bodies}
				headline={HEADLINE}
				chrome={<HomeChrome appName={branding.appName} icon={icon} />}
				footer={<SidebarFooter appName={branding.appName} />}
			/>
		</HomeAuthProvider>
	);
}
