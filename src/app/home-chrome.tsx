import { SOURCE_CODE_URL } from "@/lib/source-code";
import { HomeBrandLink } from "./home-brand-link";
import { HomeHeaderActions } from "./home-header-actions";
import { HomeThemeToggle } from "./home-theme-toggle";
import { ctaGhost } from "./home-ui";

/** The GitHub mark (lucide dropped its brand icons), drawn inline so no icon font or image is loaded. */
function GitHubMark() {
	return (
		<svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

/** The bar above the mailbox: the brand on the left, the calls to action always in view on the right. */
export function HomeChrome({ appName, icon }: { appName: string; icon: string }) {
	return (
		<header className="flex min-h-14 flex-wrap items-center justify-between gap-x-2 px-3 py-2 sm:px-4">
			<HomeBrandLink label={`${appName} home`}>
				<img src={icon} height={28} width={28} alt="" />
				<span className="hidden truncate text-lg font-bold tracking-tight text-neutral-900 min-[420px]:inline">
					{appName}
				</span>
			</HomeBrandLink>
			<div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
				<HomeThemeToggle />
				<a
					href={SOURCE_CODE_URL}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="View on GitHub"
					className={`${ctaGhost} w-9 px-0 md:w-auto md:px-4`}
				>
					<GitHubMark />
					<span className="hidden md:inline">View on GitHub</span>
				</a>
				<HomeHeaderActions />
			</div>
		</header>
	);
}
