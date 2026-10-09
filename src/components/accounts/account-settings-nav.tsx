"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
	accountSettingsNavItems,
	getAccountSettingsHref,
	isActiveAccountSettingsPath,
} from "./account-settings-nav-utils";

// A tab row on phones, where the bottom pill already belongs to the Admin menu; a side column from md up.
export function AccountSettingsNav() {
	const { id } = useParams<{ id: string }>();
	const pathname = usePathname();

	return (
		<div className="w-full shrink-0 max-md:order-first md:w-48">
			<div className="space-y-3 md:sticky md:top-6">
				<h2 className="px-4 text-xs font-semibold uppercase tracking-wide text-neutral-500 max-md:sr-only">
					Account settings
				</h2>
				<nav aria-label="Account settings" className="flex gap-1 overflow-x-auto md:flex-col md:space-y-1 md:gap-0">
					{accountSettingsNavItems.map((item) => {
						const href = getAccountSettingsHref(id, item.segment);
						const active = isActiveAccountSettingsPath(pathname, href);
						return (
							<Link
								key={item.segment || "details"}
								href={href}
								className={cn(
									"block shrink-0 rounded-full px-4 py-2.5 text-sm font-medium transition-colors",
									active ? "bg-blue-100 text-blue-900" : "text-neutral-600 hover:bg-white/70 hover:text-neutral-900",
								)}
							>
								{item.label}
							</Link>
						);
					})}
				</nav>
			</div>
		</div>
	);
}
