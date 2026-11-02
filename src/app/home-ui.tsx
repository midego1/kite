import type { ReactNode } from "react";

/* Shared classes and the section frame of the landing page. The colours are the page's own tokens
   (--home-*, set on .home-page in globals.css), so nothing here follows the app's theme. */

export const MONO = "font-(family-name:--font-geist-mono) text-xs tracking-[0.02em]";

const BUTTON =
	"inline-flex items-center justify-center gap-2 rounded-full text-[15px] font-medium transition-colors duration-200";

/** The one filled action: white on the near-black page. */
export const primaryButton = `${BUTTON} h-12 bg-(--home-ink) px-7 text-(--home-bg) hover:bg-white/80`;
export const primaryButtonSmall = `${BUTTON} h-10 bg-(--home-ink) px-5 text-(--home-bg) hover:bg-white/80`;
/** The quiet action: a hairline ring that brightens on hover. */
export const ghostButton = `${BUTTON} h-12 border border-(--home-line-strong) px-7 text-(--home-ink) hover:border-(--home-ink)`;
export const ghostButtonSmall = `${BUTTON} h-10 px-4 text-(--home-mute) hover:text-(--home-ink)`;

export const textLink =
	"text-(--home-ink) underline decoration-(--home-line-strong) underline-offset-4 transition-colors hover:decoration-(--home-ink)";

export const PAGE_X = "mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-12";

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
 * One section of the page: a hairline above it, the title in the left column and the content in the right
 * (below the title when `stacked`). No cards: the hairlines between rows do the grouping.
 */
export function HomeSection({ id, headingId, title, intro, stacked, children }: HomeSectionProps) {
	return (
		<section id={id} aria-labelledby={headingId} className="scroll-mt-4 border-t border-(--home-line)">
			<div className={`${PAGE_X} grid gap-x-10 gap-y-10 py-20 lg:grid-cols-12 lg:py-32`}>
				<div className={stacked ? "lg:col-span-7" : "lg:sticky lg:top-10 lg:col-span-4 lg:self-start"}>
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
				<div className={`min-w-0 ${stacked ? "lg:col-span-12" : "lg:col-span-8"}`}>{children}</div>
			</div>
		</section>
	);
}

type StackedClasses = Record<"table" | "head" | "body" | "row" | "rowHead" | "cell", string>;

/*
 * Classes that turn a table into stacked rows below a breakpoint: each row becomes a block, its row header a
 * heading and each cell carries its column name from `data-label`. Written out per breakpoint because Tailwind
 * only generates classes it can read whole.
 */
const STACKED: Record<"md" | "lg", StackedClasses> = {
	md: {
		table: "block w-full md:table md:min-w-[560px]",
		head: "max-md:sr-only",
		body: "block md:table-row-group",
		row: "block max-md:py-5 md:table-row",
		rowHead: "block max-md:pb-2 md:table-cell md:py-5",
		cell: "block max-md:pb-3 md:table-cell md:py-5 before:mb-0.5 before:block before:text-xs before:text-(--home-dim) before:content-[attr(data-label)] md:before:hidden",
	},
	lg: {
		table: "block w-full lg:table lg:min-w-[960px]",
		head: "max-lg:sr-only",
		body: "block lg:table-row-group",
		row: "block max-lg:py-5 lg:table-row",
		rowHead: "block max-lg:pb-2 lg:table-cell lg:py-5",
		cell: "block max-lg:pb-3 lg:table-cell lg:py-5 before:mb-0.5 before:block before:text-xs before:text-(--home-dim) before:content-[attr(data-label)] lg:before:hidden",
	},
};

type HomeTableProps = {
	/** Names the scroll region the table sits in. */
	label: string;
	/** The breakpoint from which it is a real table; below it every row is stacked. */
	from: "md" | "lg";
	/** The heading of the row-header column; left empty when the rows speak for themselves. */
	cornerLabel?: string;
	columns: { label: string; ink?: boolean }[];
	rows: { key: string; head: string; cells: string[] }[];
	rowHeadClassName: string;
};

/**
 * A hairline table with row headers. Explicit roles keep the table semantics when the rows stack on a phone,
 * and the scroll region stays focusable for the widths where the table still overflows.
 */
export function HomeTable({ label, from, cornerLabel, columns, rows, rowHeadClassName }: HomeTableProps) {
	const css = STACKED[from];
	const th = "py-3 pr-6 text-left text-sm font-normal";
	return (
		<div
			className="min-w-0 overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-(--home-signal)"
			tabIndex={0}
			role="region"
			aria-label={label}
		>
			<table className={`${css.table} border-collapse text-left text-[15px]`} role="table">
				<thead className={css.head} role="rowgroup">
					<tr role="row" className={from === "lg" ? "lg:table-row" : "md:table-row"}>
						{cornerLabel ? (
							<th scope="col" role="columnheader" className={`${th} text-(--home-dim)`}>
								{cornerLabel}
							</th>
						) : (
							<td role="cell" className="w-44" />
						)}
						{columns.map((column) => (
							<th
								key={column.label}
								scope="col"
								role="columnheader"
								className={`${th} ${column.ink ? "text-(--home-ink)" : "text-(--home-dim)"}`}
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody className={css.body} role="rowgroup">
					{rows.map((row) => (
						<tr key={row.key} role="row" className={`${css.row} border-t border-(--home-line) align-top`}>
							<th scope="row" role="rowheader" className={`${css.rowHead} pr-6 text-left ${rowHeadClassName}`}>
								{row.head}
							</th>
							{row.cells.map((cell, index) => (
								<td
									key={columns[index].label}
									role="cell"
									data-label={columns[index].label}
									className={`${css.cell} pr-6 leading-6 ${columns[index].ink ? "text-(--home-ink)" : "text-(--home-mute)"}`}
								>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
