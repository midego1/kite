import { formatDecimal } from "./amount-utils";
import { paymentCategoryOf } from "./category-utils";

/** A row of the Payments CSV: what the tab shows, as plain values. */
export type PaymentCsvRow = {
	documentOn: string;
	vendor: string;
	docType: string;
	status: string;
	amount: { minor: number; currency: string } | null;
	category: string | null;
	/** `payment` for a payment found in mail (written as `mail`), `subscription` for a tracked subscription's document. */
	source: "payment" | "subscription";
};

const HEADER = ["Date", "Vendor", "Type", "Status", "Amount", "Currency", "Category", "Source"];

/**
 * Characters a spreadsheet reads as the start of a formula when they open a cell: the ASCII operators, the fullwidth
 * ones CJK-locale builds accept, the old DDE pipe, and any leading whitespace (a no-break space or a zero-width
 * character included), which some programs skip before looking for the operator.
 */
const FORMULA_START = /^[\s\u200b-\u200d\u2060\ufeff=+\-@|\uff1d\uff0b\uff0d\uff20]/;

/**
 * One text cell, safe to open in a spreadsheet: a value that would start a formula (`=`, `+`, `-`, `@`, a tab or a
 * line break, a vendor name is whatever the sender printed) gets a leading apostrophe, then the cell is quoted when it
 * holds a comma, a quote or a line break. Numbers do not come through here, so a refund's "-5.00" stays a number.
 * @public Exercised by the bundled unit tests.
 */
export function csvText(value: string): string {
	const text = FORMULA_START.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const SIGNED: Record<string, number> = { credit: -1, refund: -1 };

/** The amount as a signed decimal in the currency's own digits: refunds and credit notes are negative. */
function amountCell(row: PaymentCsvRow): string {
	if (!row.amount) return "";
	const sign = (SIGNED[row.docType] ?? 1) < 0 ? "-" : "";
	return `${sign}${formatDecimal(row.amount.minor, row.amount.currency)}`;
}

/** The Payments tab as CSV (RFC 4180, CRLF, a byte order mark so a spreadsheet reads UTF-8); no totals row. */
export function paymentsCsv(rows: readonly PaymentCsvRow[]): string {
	const lines = rows.map((row) =>
		[
			// Every text column goes through csvText, so the guard never relies on the database holding known values.
			csvText(row.documentOn),
			csvText(row.vendor),
			csvText(row.docType),
			csvText(row.status),
			amountCell(row),
			csvText(row.amount?.currency ?? ""),
			csvText(paymentCategoryOf(row.category) ?? ""),
			row.source === "payment" ? "mail" : "subscription",
		].join(","),
	);
	return `﻿${[HEADER.join(","), ...lines].join("\r\n")}\r\n`;
}
