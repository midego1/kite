// A receipt laid out the way payment providers send them, with synthetic data: nested tables, a description cell at
// `width: 100%` beside an amount cell, inline styles with shorthands (`border: 0`, `white-space: nowrap`), a `nowrap`
// attribute, an amount cell without either, and a long URL written out in a cell. The `<style>` block is dropped by
// both sanitizers, as mail clients that strip head styles do.

const FONT = "-apple-system,'SF Pro Display',Roboto,'Helvetica Neue',Ubuntu,sans-serif";
const CELL = `border:0;border-collapse:collapse;margin:0;padding:0;font-family:${FONT};font-size:15px;line-height:24px`;

export const RECEIPT_AMOUNT = "$500.00";
export const RECEIPT_URL =
	"https://support.example.com/questions/receipts/very/long/path/that/keeps/going/and/going?ref=receipt-0123456789abcdef";

/** @param {{ description?: string, total?: string, dir?: "ltr" | "rtl" }} [options] */
export function receiptTableHtml({ description = "Incorporate your startup × 1", total = "Amount paid", dir } = {}) {
	return [
		`<!doctype html><html${dir ? ` dir="${dir}"` : ""}><head><style>.Table-amount{white-space:nowrap}</style></head>`,
		'<body style="background-color:#f6f9fc">',
		'<table width="100%" border="0" cellpadding="0" cellspacing="0" style="border:0;border-collapse:collapse;width:100%;background-color:#f6f9fc"><tbody><tr><td>',
		'<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" style="border:0;border-collapse:collapse;margin:0 auto;width:100%;max-width:600px"><tbody><tr><td>',
		'<table width="100%" style="background-color:#ffffff;border-radius:5px"><tbody>',
		`<tr><td style="padding:32px 48px;font-family:${FONT};font-size:24px;line-height:32px;color:#32325d">Your receipt from Example Atlas</td></tr>`,
		'<tr><td style="padding:0 48px;font-size:12px;color:#8898aa;text-transform:uppercase">Receipt #1234-5678</td></tr>',
		'<tr><td style="padding:16px 48px">',
		'<table width="100%" border="0" cellpadding="0" cellspacing="0" style="border:0;border-collapse:collapse;width:100%"><tbody>',
		"<tr>",
		`<td class="Table-description" style="${CELL};color:#525f7f !important;width:100%">${description}</td>`,
		`<td width="8" style="${CELL};color:#ffffff;font-size:1px;line-height:1px">&nbsp;</td>`,
		`<td class="Table-amount" align="right" valign="top" nowrap style="${CELL};color:#525f7f !important;vertical-align:top;white-space:nowrap;text-align:right">${RECEIPT_AMOUNT}</td>`,
		"</tr>",
		'<tr><td colspan="3" style="border-top:1px solid #e6ebf1;height:1px;font-size:1px;line-height:1px">&nbsp;</td></tr>',
		"<tr>",
		`<td class="Table-description" style="font-size:15px;line-height:24px;width:100%;font-weight:bold;color:#525f7f">${total}</td>`,
		'<td width="8">&nbsp;</td>',
		`<td class="Table-amount" align="right" valign="top" style="font-size:15px;line-height:24px;font-weight:bold;color:#525f7f">${RECEIPT_AMOUNT}</td>`,
		"</tr>",
		"</tbody></table>",
		"</td></tr>",
		`<tr><td style="padding:16px 48px;font-size:12px;color:#8898aa">Questions? Visit ${RECEIPT_URL}</td></tr>`,
		"</tbody></table>",
		"</td></tr></tbody></table>",
		"</td></tr></tbody></table>",
		"</body></html>",
	].join("");
}
