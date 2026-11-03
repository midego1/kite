import { SOURCE_CODE_URL } from "@/lib/source-code";
import { UPSTREAM_URL, footerLinks } from "./utils";

/** The attribution at the foot of the sidebar: the licence, the upstream project and the project links. */
export function SidebarFooter({ appName }: { appName: string }) {
	return (
		<div className="space-y-3 border-t border-neutral-200 px-1 pt-3 text-xs leading-5 text-neutral-500">
			<p>
				{appName} is free software under the AGPL-3.0. Based on{" "}
				<a
					href={UPSTREAM_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="font-medium text-neutral-700 underline underline-offset-2 hover:text-neutral-900"
				>
					Mailflare
				</a>{" "}
				by hieunc229.
			</p>
			<nav aria-label="Project links" className="flex flex-wrap gap-x-3 gap-y-1">
				{footerLinks.map((link) => (
					<a
						key={link.href}
						href={link.href}
						target="_blank"
						rel="noopener noreferrer"
						className="py-0.5 hover:text-neutral-900 hover:underline"
						{...(link.href === SOURCE_CODE_URL ? { "data-source-link": "" } : {})}
					>
						{link.label}
					</a>
				))}
			</nav>
		</div>
	);
}
