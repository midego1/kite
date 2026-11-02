"use client";

import Link from "next/link";
import { getHomeActions } from "./utils";
import { HomeAccountMenu } from "./home-account-menu";
import { useHomeAuth } from "./home-auth";
import { ghostButtonSmall, primaryButtonSmall } from "./home-ui";

export function HomeHeaderActions() {
	const user = useHomeAuth();
	if (user) return <HomeAccountMenu user={user} />;

	return (
		<>
			{getHomeActions(false).map((action) =>
				action.external ? (
					// The deploy button has its place in the hero; the header keeps only Sign in on a phone.
					<a
						key={action.href}
						href={action.href}
						target="_blank"
						rel="noopener noreferrer"
						className={`${primaryButtonSmall} max-sm:hidden`}
					>
						{action.label}
					</a>
				) : (
					<Link key={action.href} href={action.href} className={ghostButtonSmall}>
						{action.label}
					</Link>
				),
			)}
		</>
	);
}
