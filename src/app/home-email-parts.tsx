import type { ReactNode } from "react";
import { MONO } from "./home-ui";
import type { HomeTextPart } from "./types";

/* The pieces the emails are written with: prose in the reader's own classes, links, schedules as real tables. */

export const LINK =
	"font-medium text-blue-700 underline underline-offset-4 hover:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
			{children}
		</a>
	);
}

export function Para({ children }: { children: ReactNode }) {
	return <p className="text-[15px] leading-7 text-neutral-800">{children}</p>;
}

export function Quiet({ children }: { children: ReactNode }) {
	return <p className="text-sm leading-6 text-neutral-500">{children}</p>;
}

/** A heading inside an email; the Welcome email's subject is the page's h1, so its headings are h2. */
export function Heading({ children, level = 3 }: { children: ReactNode; level?: 2 | 3 }) {
	const Tag = `h${level}` as const;
	return <Tag className="pt-2 text-lg font-semibold tracking-tight text-neutral-900">{children}</Tag>;
}

export function Bullets({ items }: { items: string[] }) {
	return (
		<ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-7 text-neutral-700 marker:text-neutral-400">
			{items.map((item) => (
				<li key={item}>{item}</li>
			))}
		</ul>
	);
}

export function Mono({ children }: { children: ReactNode }) {
	return <p className={`${MONO} text-neutral-500`}>{children}</p>;
}

/** A text with links and inline code, as the FAQ stores its answers. */
export function Parts({ parts }: { parts: HomeTextPart[] }) {
	return (
		<>
			{parts.map((part) => {
				if (part.href)
					return (
						<ExternalLink key={part.text} href={part.href}>
							{part.text}
						</ExternalLink>
					);
				if (part.code) {
					return (
						<code
							key={part.text}
							className={`${MONO} rounded border border-neutral-200 bg-neutral-100 px-1.5 py-0.5 text-neutral-900`}
						>
							{part.text}
						</code>
					);
				}
				return <span key={part.text}>{part.text}</span>;
			})}
		</>
	);
}

type EmailTableProps = {
	/** Names the table for assistive technology. */
	label: string;
	/** The heading of the row-header column; empty when the rows speak for themselves. */
	cornerLabel?: string;
	columns: { label: string; ink?: boolean; big?: boolean }[];
	rows: { key: string; head: string; cells: string[] }[];
	/** The container width from which it is a table; narrower, each row stacks with its columns named. */
	from: "wide" | "narrow";
};

// Container queries, so the table follows the reader's width and not the window's. Written out whole for Tailwind.
const STACK = {
	narrow: {
		table: "block w-full @xl:table",
		head: "@max-xl:sr-only",
		body: "block @xl:table-row-group",
		row: "block @max-xl:py-4 @xl:table-row",
		rowHead: "block @max-xl:pb-1.5 @xl:table-cell @xl:py-4",
		cell: "block @max-xl:pb-2.5 @xl:table-cell @xl:py-4 before:mb-0.5 before:block before:text-xs before:text-neutral-500 before:content-[attr(data-label)] @xl:before:hidden",
	},
	wide: {
		table: "block w-full @5xl:table",
		head: "@max-5xl:sr-only",
		body: "block @5xl:table-row-group",
		row: "block @max-5xl:py-4 @5xl:table-row",
		rowHead: "block @max-5xl:pb-1.5 @5xl:table-cell @5xl:py-4",
		cell: "block @max-5xl:pb-2.5 @5xl:table-cell @5xl:py-4 before:mb-0.5 before:block before:text-xs before:text-neutral-500 before:content-[attr(data-label)] @5xl:before:hidden",
	},
} as const;

/**
 * A real table with row headers. Explicit roles keep its semantics when the rows stack in a narrow reader, where
 * every cell names its column.
 */
export function EmailTable({ label, cornerLabel, columns, rows, from }: EmailTableProps) {
	const css = STACK[from];
	const th = "py-2 pr-4 text-left text-xs font-medium";
	return (
		<table className={`${css.table} border-collapse text-left text-sm`} role="table" aria-label={label}>
			<thead className={css.head} role="rowgroup">
				<tr role="row">
					{cornerLabel ? (
						<th scope="col" role="columnheader" className={`${th} text-neutral-500`}>
							{cornerLabel}
						</th>
					) : (
						<td role="cell" />
					)}
					{columns.map((column, index) => (
						<th
							key={index}
							scope="col"
							role="columnheader"
							className={`${th} ${column.ink ? "text-neutral-900" : "text-neutral-500"}`}
						>
							{column.label}
						</th>
					))}
				</tr>
			</thead>
			<tbody className={css.body} role="rowgroup">
				{rows.map((row) => (
					<tr key={row.key} role="row" className={`${css.row} border-t border-neutral-200 align-top`}>
						<th scope="row" role="rowheader" className={`${css.rowHead} pr-4 text-left font-medium text-neutral-900`}>
							{row.head}
						</th>
						{row.cells.map((cell, index) => (
							<td
								key={index}
								role="cell"
								data-label={columns[index].label}
								className={`${css.cell} pr-4 leading-6 ${columns[index].big ? "text-lg" : ""} ${
									columns[index].ink ? "text-neutral-900" : "text-neutral-600"
								}`}
							>
								{cell}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}
