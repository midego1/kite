"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

/**
 * The brand in the chrome goes home. On the home page itself that means the Welcome email at /, which is a change of
 * URL without a hash change, so it announces one for the mailbox to follow.
 */
export function HomeBrandLink({ label, children }: { label: string; children: ReactNode }) {
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (window.location.pathname !== "/") return;
		event.preventDefault();
		if (window.location.hash) {
			window.history.pushState(null, "", "/");
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		}
	};
	return (
		<Link href="/" onClick={onClick} className="flex min-w-0 items-center gap-2.5" aria-label={label}>
			{children}
		</Link>
	);
}
