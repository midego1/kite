import type { ReactNode } from "react";

/* Shared classes and the frame of the landing page, which is laid out as one engineering drawing sheet: a
   border with zone ticks, a hairline between sections, registration crosses where those lines meet, schedules
   for tables and a title block for a footer. The colours are the page's own tokens (--home-*, set on
   .home-page in globals.css), so nothing here follows the app's theme. */

export const MONO = "font-(family-name:--font-geist-mono) text-[13px] tracking-[0.02em]";

const BUTTON =
	"inline-flex items-center justify-center gap-2 rounded-full text-[15px] font-medium transition-colors duration-200";

/** The one filled action: white on the near-black sheet. */
export const primaryButton = `${BUTTON} h-12 bg-(--home-ink) px-7 text-(--home-bg) hover:bg-white/80`;
export const primaryButtonSmall = `${BUTTON} h-10 bg-(--home-ink) px-5 text-(--home-bg) hover:bg-white/80`;
/** The quiet action: a hairline ring that brightens on hover. */
export const ghostButton = `${BUTTON} h-12 border border-(--home-line-strong) px-7 text-(--home-ink) hover:border-(--home-ink)`;
export const ghostButtonSmall = `${BUTTON} h-10 px-4 text-(--home-mute) hover:text-(--home-ink)`;

export const textLink =
	"text-(--home-ink) underline decoration-(--home-line-strong) underline-offset-4 transition-colors hover:decoration-(--home-ink)";

/** The sheet: a bordered column the page's rules run between. */
export const SHEET = "mx-auto w-full max-w-[1440px] border-x border-(--home-line-strong)";
export const PAD = "px-5 sm:px-8 lg:px-12";

/** A registration cross, drawn where a section rule meets the sheet border. */
export function Cross({ className }: { className: string }) {
	return (
		<span aria-hidden="true" className={`pointer-events-none absolute z-10 hidden h-3 w-3 sm:block ${className}`}>
			<span className="absolute left-0 top-1/2 h-px w-full bg-(--home-line-strong)" />
			<span className="absolute left-1/2 top-0 h-full w-px bg-(--home-line-strong)" />
		</span>
	);
}

type HomeSectionProps = {
	id?: string;
	headingId: string;
	title: string;
	intro?: ReactNode;
	/** Content under the title instead of beside it, for wide tables. */
	stacked?: boolean;
	children: ReactNode;
};

/**
 * One section: a rule across the sheet with a cross at each end, the title in a left cell whose edge is a
 * vertical hairline shared by every section, and the content to its right (below the title when `stacked`).
 */
export function HomeSection({ id, headingId, title, intro, stacked, children }: HomeSectionProps) {
	return (
		<section id={id} aria-labelledby={headingId} className="relative scroll-mt-4 border-t border-(--home-line)">
			<Cross className="left-0 -top-[6.5px]" />
			<Cross className="right-0 -top-[6.5px]" />
			<div className="grid lg:grid-cols-12">
				<div
					className={`${PAD} pb-6 pt-16 lg:pb-32 lg:pt-28 ${
						stacked ? "lg:col-span-7" : "lg:sticky lg:top-0 lg:col-span-4 lg:self-start"
					}`}
				>
					<h2
						id={headingId}
						className="text-balance text-[clamp(1.9rem,3.4vw,3rem)] font-medium leading-[1.08] tracking-[-0.03em]"
					>
						{title}
					</h2>
					{intro && (
						<div className="mt-5 max-w-[34rem] text-pretty text-base leading-7 text-(--home-mute)">{intro}</div>
					)}
				</div>
				<div
					className={`min-w-0 ${PAD} ${stacked ? "pb-16 lg:col-span-12 lg:pb-28" : "pb-16 pt-4 lg:col-span-8 lg:border-l lg:border-(--home-line) lg:py-28 lg:pl-12"}`}
				>
					{children}
				</div>
			</div>
		</section>
	);
}
