"use client";

import Link from "next/link";
import { getHomeActions } from "./utils";
import { HomeAccountMenu } from "./home-account-menu";
import { useHomeAuth } from "./home-auth";
import { ctaGhost, ctaPrimary } from "./home-ui";

/**
 * The chrome's account buttons: Sign in and Deploy to Cloudflare for a visitor, Open dashboard and the account
 * menu for a signed-in user. On a phone the deploy label is cut to "Deploy" and the rest stays for assistive technology.
 */
export function HomeHeaderActions() {
	const user = useHomeAuth();
	if (user) {
		const [dashboard] = getHomeActions(true);
		return (
			<>
				<Link href={dashboard.href} className={ctaPrimary}>
					{dashboard.label}
				</Link>
				<HomeAccountMenu user={user} />
			</>
		);
	}

	return (
		<>
			{getHomeActions(false).map((action) =>
				action.external ? (
					<a key={action.href} href={action.href} target="_blank" rel="noopener noreferrer" className={ctaPrimary}>
						<span>
							Deploy<span className="sr-only sm:not-sr-only">{" to Cloudflare"}</span>
						</span>
					</a>
				) : (
					<Link key={action.href} href={action.href} className={ctaGhost}>
						{action.label}
					</Link>
				),
			)}
		</>
	);
}
