/*
 * A schedule: a hairline table with row headers that stacks into labelled rows below a breakpoint. Explicit roles
 * keep the table semantics when the rows stack on a phone, and the scroll region stays focusable for the widths
 * where the table still overflows.
 */

type StackedClasses = Record<"table" | "head" | "body" | "row" | "rowHead" | "cell", string>;

// Written out per breakpoint because Tailwind only generates classes it can read whole.
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
	/** `ink` brightens the column; `big` sets its cells at display size, for the figures that are the point. */
	columns: { label: string; ink?: boolean; big?: boolean }[];
	rows: { key: string; head: string; cells: string[] }[];
	rowHeadClassName: string;
};

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
							{row.cells.map((cell, index) => {
								const column = columns[index];
								return (
									<td
										key={column.label}
										role="cell"
										data-label={column.label}
										className={`${css.cell} pr-6 ${column.big ? "text-xl leading-7 tracking-[-0.01em]" : "leading-6"} ${
											column.ink ? "text-(--home-ink)" : "text-(--home-mute)"
										}`}
									>
										{cell}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
