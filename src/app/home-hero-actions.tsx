"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import { getHeroActions } from "./utils";
import { useHomeAuth } from "./home-auth";

/** The GitHub mark (lucide dropped its brand icons), drawn inline so no icon font or image is loaded. */
function GitHubMark() {
	return (
		<svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

/** The hero's buttons: the dashboard for a signed-in user, the deploy and self-host guides for a visitor. */
export function HomeHeroActions() {
	const hasUser = !!useHomeAuth();

	return (
		<div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
			{getHeroActions(hasUser).map((action, index) => (
				<Button
					key={action.href}
					size="lg"
					variant={action.variant}
					asChild
					className={
						action.variant === "outline" ? "rounded-full border-neutral-200 bg-white px-6" : "rounded-full px-6"
					}
				>
					{action.external ? (
						<a href={action.href} target="_blank" rel="noopener noreferrer">
							{action.label}
							{index === 0 ? <ArrowRight className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
						</a>
					) : (
						<Link href={action.href}>
							{action.label}
							{index === 0 && <ArrowRight className="h-4 w-4" />}
						</Link>
					)}
				</Button>
			))}
			<Button size="lg" variant="ghost" asChild className="rounded-full px-5">
				<a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer">
					<GitHubMark />
					Source on GitHub
				</a>
			</Button>
		</div>
	);
}
