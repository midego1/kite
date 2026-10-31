"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getHomeActions } from "./utils";
import { HomeAccountMenu } from "./home-account-menu";
import { useHomeAuth } from "./home-auth";

export function HomeHeaderActions() {
	const user = useHomeAuth();
	if (user) return <HomeAccountMenu user={user} />;

	return (
		<>
			{getHomeActions(false).map((action) => (
				<Button
					key={action.href}
					variant={action.variant}
					asChild
					// The deploy button has its place in the hero; the header keeps only Sign in on a phone.
					className={action.external ? "hidden sm:inline-flex" : undefined}
				>
					{action.external ? (
						<a href={action.href} target="_blank" rel="noopener noreferrer">
							{action.label}
						</a>
					) : (
						<Link href={action.href}>{action.label}</Link>
					)}
				</Button>
			))}
		</>
	);
}
