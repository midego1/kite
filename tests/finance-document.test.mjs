import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const { classifyDocument, docTypeOfText, docTypeOfFilenames, documentAttachment, documentDate, documentPeriod } =
	await loadFinance("document-utils");

const DATES = { messageDay: "2026-10-14", monthFirst: false };
const pdf = (id, filename) => ({ id, contentType: "application/pdf", filename, size: 1000 });
const image = (id, filename) => ({ id, contentType: "image/png", filename, size: 1000 });

function classify(overrides = {}) {
	return classifyDocument({
		subject: "",
		excerpt: "",
		attachments: [],
		paymentFailed: false,
		hasAmount: true,
		dates: DATES,
		...overrides,
	});
}

test("each type is recognised in English, Dutch, German, French and Spanish", () => {
	const cases = {
		invoice: ["Your invoice", "Uw factuur", "Ihre Rechnung", "Votre facture", "Su factura", "Amount due"],
		payment: [
			"Your receipt",
			"Betaling ontvangen",
			"Zahlungsbestätigung",
			"Paiement reçu",
			"Pago recibido",
			"Thank you for your payment",
		],
		credit: ["Credit note 12", "Creditnota", "Gutschrift", "Avoir n° 5", "Nota de crédito"],
		refund: ["Refund issued", "Terugbetaling", "Rückerstattung", "Remboursement", "Reembolso"],
	};
	for (const [type, subjects] of Object.entries(cases))
		for (const subject of subjects) assert.equal(docTypeOfText(subject), type, subject);
	assert.equal(docTypeOfText("Lunch on Friday?"), null);
});

test("precedence is refund > credit > payment > invoice", () => {
	assert.equal(docTypeOfText("Invoice #123 paid"), "payment");
	assert.equal(docTypeOfText("Refund for your payment"), "refund");
	assert.equal(docTypeOfText("Credit note for invoice 7"), "credit");
	assert.equal(docTypeOfText("Refund and credit note"), "refund");
	assert.equal(docTypeOfText("Unpaid invoice"), "invoice");
});

test("payment-failed phrases always win and need no amount", () => {
	const document = classify({ subject: "Your invoice", paymentFailed: true, hasAmount: false });
	assert.equal(document.docType, "failed_payment");
	assert.equal(document.confident, true);
});

test("subject and filename matches are confident, a body-only match is weak", () => {
	assert.deepEqual(
		[classify({ subject: "Your receipt" }).docType, classify({ subject: "Your receipt" }).confident],
		["payment", true],
	);
	const fromFile = classify({ subject: "Hello", attachments: [pdf("a1", "rechnung-2026.pdf")] });
	assert.deepEqual([fromFile.docType, fromFile.confident], ["invoice", true]);
	const fromBody = classify({ subject: "Hello", excerpt: "Here is your invoice." });
	assert.deepEqual([fromBody.docType, fromBody.confident], ["invoice", false]);
	assert.equal(classify({ subject: "Receipt", excerpt: "Refund" }).docType, "payment");
});

test("filenames map to types, with the same precedence", () => {
	assert.equal(docTypeOfFilenames([pdf("1", "receipt.pdf")]), "payment");
	assert.equal(docTypeOfFilenames([pdf("1", "recibo.pdf")]), "payment");
	assert.equal(docTypeOfFilenames([pdf("1", "invoice.pdf"), pdf("2", "refund.pdf")]), "refund");
	assert.equal(docTypeOfFilenames([pdf("1", "Gutschrift.pdf")]), "credit");
	assert.equal(
		docTypeOfFilenames([pdf("1", "photo.pdf"), { id: "2", contentType: "x", filename: null, size: 1 }]),
		null,
	);
});

test("no match gives no document, and an amount is required except for failed payments", () => {
	assert.equal(classify({ subject: "Your trial ends soon" }), null);
	assert.equal(classify({ subject: "Your invoice", hasAmount: false }), null);
});

test("document date: a labelled date within -400/+1 days, else the message date", () => {
	assert.equal(documentDate("Invoice date: 3 Oct 2026", DATES), "2026-10-03");
	assert.equal(documentDate("Factuurdatum 01-10-2026 2026-10-01", DATES), "2026-10-01");
	assert.equal(documentDate("Date paid: October 2, 2026", DATES), "2026-10-02");
	assert.equal(documentDate("Invoice date: 3 Oct 2024", DATES), "2026-10-14");
	assert.equal(documentDate("Invoice date: 20 Oct 2026", DATES), "2026-10-14");
	assert.equal(documentDate("Invoice date: 15 Oct 2026", DATES), "2026-10-15");
	assert.equal(documentDate("Invoice date: 3 Oct", DATES), "2026-10-14");
	assert.equal(documentDate("Invoice date: 15 Oct", DATES), "2026-10-15");
	assert.equal(documentDate("Invoice date: 14 Oct", DATES), "2026-10-14");
	assert.equal(documentDate("Invoice date: 03/04/2026", DATES), "2026-10-14");
	assert.equal(documentDate("Invoice date: soon", DATES), "2026-10-14");
	assert.equal(documentDate("No label 3 Oct 2026", DATES), "2026-10-14");
});

test("period ranges: separators, open start year, bounds", () => {
	assert.deepEqual(documentPeriod("Billing period: 1 Oct 2026 – 31 Oct 2026", DATES), {
		start: "2026-10-01",
		end: "2026-10-31",
	});
	assert.deepEqual(documentPeriod("Service period Oct 1 - Oct 31, 2026", DATES), {
		start: "2026-10-01",
		end: "2026-10-31",
	});
	assert.deepEqual(documentPeriod("For the period 1 Dec to 31 Jan 2027", DATES), {
		start: "2026-12-01",
		end: "2027-01-31",
	});
	assert.deepEqual(documentPeriod("Zeitraum 01.10.2026 bis 31.10.2026", DATES), {
		start: "2026-10-01",
		end: "2026-10-31",
	});
	assert.equal(documentPeriod("Billing period: 31 Oct 2026 - 1 Oct 2026", DATES), null);
	assert.equal(documentPeriod("Billing period: 1 Oct 2025 - 31 Oct 2026", DATES), null);
	assert.equal(documentPeriod("Billing period: 1 Jan 2020 - 31 Jan 2020", DATES), null);
	assert.equal(documentPeriod("Billing period: 1 Oct 2026 and later 31 Oct 2026", DATES), null);
	assert.deepEqual(documentPeriod("Billing period: 1 Oct 2026 - 31 Oct", DATES), {
		start: "2026-10-01",
		end: "2026-10-31",
	});
	assert.deepEqual(documentPeriod("Billing period: 15 Dec 2026 - 14 Jan", DATES), {
		start: "2026-12-15",
		end: "2027-01-14",
	});
	assert.equal(documentPeriod("Billing period: 1 Oct - 31 Oct", DATES), null);
	assert.equal(documentPeriod("Billing period: October", DATES), null);
});

test("period ranges: ambiguous numeric endpoints far from the message are dropped", () => {
	const EUR = DATES;
	assert.equal(documentPeriod("Billing period: 03/04/2027 - 04/05/2027", EUR), null);
	assert.equal(documentPeriod("Billing period: 03/04/2026 - 04/05/2026", EUR), null);
	// 30/09 can only be day first, so 01/09 is read the same way.
	assert.deepEqual(documentPeriod("Billing period: 01/09/2026 - 30/09/2026", EUR), {
		start: "2026-09-01",
		end: "2026-09-30",
	});
	assert.deepEqual(documentPeriod("Billing period: 15/08/2026 - 01/09/2026", EUR), {
		start: "2026-08-15",
		end: "2026-09-01",
	});
	// 09/30 only reads month first, the opposite order, so it settles nothing about 09/01.
	assert.equal(documentPeriod("Billing period: 09/01/2026 - 09/30/2026", EUR), null);
	// Within 31 days an ambiguous endpoint needs no help.
	assert.deepEqual(documentPeriod("Billing period: 01/10/2026 - 31/10/2026", EUR), {
		start: "2026-10-01",
		end: "2026-10-31",
	});
	assert.deepEqual(documentPeriod("Billing period: 09/01/2026 - 09/30/2026", { ...EUR, monthFirst: true }), {
		start: "2026-09-01",
		end: "2026-09-30",
	});
	assert.deepEqual(documentPeriod("Billing period: 1 Sep 2026 - 30 Sep 2026", EUR), {
		start: "2026-09-01",
		end: "2026-09-30",
	});
});

test("attachment choice: keyword PDF, then keyword image, then a lone PDF, else none", () => {
	assert.equal(documentAttachment([image("i", "receipt.png"), pdf("p", "invoice-1.pdf")]), "p");
	assert.equal(documentAttachment([image("i", "receipt.png"), pdf("p", "terms.pdf"), pdf("q", "more.pdf")]), "i");
	assert.equal(documentAttachment([pdf("p", "statement.pdf")]), "p");
	assert.equal(documentAttachment([pdf("p", "a.pdf"), pdf("q", "b.pdf")]), null);
	assert.equal(documentAttachment([{ id: "t", contentType: "text/plain", filename: "invoice.txt", size: 1 }]), null);
	assert.equal(documentAttachment([]), null);
});

test("a classified document carries its date, period and attachment", () => {
	const document = classify({
		subject: "Your invoice",
		excerpt: "Invoice date: 1 Oct 2026\nBilling period: 1 Oct 2026 - 31 Oct 2026",
		attachments: [pdf("att-1", "invoice-2026-10.pdf")],
	});
	assert.deepEqual(document, {
		docType: "invoice",
		confident: true,
		documentOn: "2026-10-01",
		periodStartOn: "2026-10-01",
		periodEndOn: "2026-10-31",
		attachmentId: "att-1",
	});
});
