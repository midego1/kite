/**
 * The phrase lists Money Watch matches in receipts, in English, Dutch, German, French and Spanish.
 * Every list is plain literals joined into one alternation, so matching stays linear in the text.
 */

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A case-insensitive matcher for whole words or phrases from the list; letters around a match make it no match. */
export function phraseRegex(phrases: readonly string[], flags = "iu"): RegExp {
	const alternation = [...phrases]
		.sort((a, b) => b.length - a.length)
		.map((phrase) => escapeRegex(phrase).replace(/ /g, "\\s+"))
		.join("|");
	return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}])`, flags);
}

const SUBJECT_WORDS = [
	// English
	"receipt",
	"invoice",
	"payment received",
	"payment confirmation",
	"billing",
	"renewal",
	"renews",
	"renewed",
	"subscription",
	"membership",
	"plan",
	"trial",
	// Dutch
	"factuur",
	"betaling",
	"betalingsbewijs",
	"abonnement",
	"lidmaatschap",
	"verlenging",
	"proefperiode",
	// German
	"rechnung",
	"quittung",
	"zahlung",
	"zahlungsbestätigung",
	"abo",
	"mitgliedschaft",
	"verlängerung",
	"testphase",
	// French
	"facture",
	"reçu",
	"paiement",
	"adhésion",
	"renouvellement",
	"essai",
	// Spanish
	"factura",
	"recibo",
	"pago",
	"suscripción",
	"membresía",
	"renovación",
	"prueba",
];

const PAYMENT_FAILED_PHRASES = [
	"payment failed",
	"payment declined",
	"declined",
	"unable to process your payment",
	"update your payment method",
	"past due",
	"payment unsuccessful",
	"payment was unsuccessful",
	"betaling mislukt",
	"betaling is mislukt",
	"betaling geweigerd",
	"zahlung fehlgeschlagen",
	"zahlung abgelehnt",
	"zahlungsmethode aktualisieren",
	"paiement a échoué",
	"échec du paiement",
	"paiement refusé",
	"mettre à jour votre moyen de paiement",
	"pago fallido",
	"pago rechazado",
	"no pudimos procesar tu pago",
	"no pudimos procesar su pago",
	"actualiza tu método de pago",
];

export const REFUND_PHRASES = [
	"refund",
	"refunded",
	"has been refunded",
	"refund issued",
	"terugbetaling",
	"terugbetaald",
	"rückerstattung",
	"erstattet",
	"remboursement",
	"remboursé",
	"reembolso",
	"reembolsado",
];

export const CREDIT_PHRASES = [
	"credit note",
	"credit memo",
	"account credit",
	"credited to your account",
	"creditnota",
	"creditfactuur",
	"gutschrift",
	"avoir",
	"note de crédit",
	"nota de crédito",
	"abono",
];

export const PAYMENT_PHRASES = [
	"receipt",
	"payment received",
	"payment confirmation",
	"thank you for your payment",
	"amount paid",
	"paid",
	"you've been charged",
	"you have been charged",
	"we charged",
	"betalingsbewijs",
	"betaling ontvangen",
	"betaald",
	"zahlungsbestätigung",
	"quittung",
	"zahlung erhalten",
	"bezahlt",
	"reçu",
	"paiement reçu",
	"confirmation de paiement",
	"payé",
	"recibo",
	"pago recibido",
	"confirmación de pago",
	"pagado",
];

export const INVOICE_PHRASES = [
	"invoice",
	"amount due",
	"balance due",
	"payment due",
	"your bill",
	"factuur",
	"te betalen",
	"rechnung",
	"fälliger betrag",
	"facture",
	"montant dû",
	"factura",
	"importe a pagar",
];

/** Subject words of §5.3, plus every document phrase, so "Refund issued" or "Credit note" count as billing subjects. */
export const SUBJECT_KEYWORD = phraseRegex([
	...new Set([
		...SUBJECT_WORDS,
		...PAYMENT_FAILED_PHRASES,
		...REFUND_PHRASES,
		...CREDIT_PHRASES,
		...PAYMENT_PHRASES,
		...INVOICE_PHRASES,
	]),
]);

export const PAYMENT_FAILED = phraseRegex(PAYMENT_FAILED_PHRASES);

export const RENEWAL_PHRASE = phraseRegex([
	"renews on",
	"renews",
	"will renew on",
	"will renew",
	"auto-renews on",
	"auto-renews",
	"renewal date",
	"renewal on",
	"next renewal",
	"next renewal date",
	"next billing date",
	"next payment",
	"next payment date",
	"your next charge",
	"next charge",
	"verlengt op",
	"wordt verlengd op",
	"volgende betaling",
	"volgende verlenging",
	"volgende factuurdatum",
	"verlängert sich am",
	"verlängerung am",
	"nächste zahlung",
	"nächste verlängerung",
	"nächste abbuchung",
	"se renouvelle le",
	"renouvelé le",
	"prochain paiement",
	"prochain renouvellement",
	"prochaine facturation",
	"prochain prélèvement",
	"se renueva el",
	"próximo pago",
	"próxima renovación",
	"próxima facturación",
	"próximo cobro",
]);

export const TRIAL_PHRASE = phraseRegex([
	"trial ends",
	"trial ends on",
	"trial will end",
	"trial expires",
	"free trial ends",
	"free trial until",
	"trial until",
	"proefperiode eindigt",
	"proefperiode loopt af",
	"testphase endet",
	"probezeit endet",
	"testzeitraum endet",
	"essai se termine",
	"essai gratuit prend fin",
	"période d'essai se termine",
	"prueba termina",
	"prueba gratuita finaliza",
	"prueba vence",
]);

/** The words a cycle phrase stands for; quarterly comes first so "every 3 months" is not read as monthly. */
export const CYCLE_PHRASES = {
	quarterly: phraseRegex([
		"quarterly",
		"every 3 months",
		"every three months",
		"per quarter",
		"per kwartaal",
		"vierteljährlich",
		"pro quartal",
		"trimestriel",
		"trimestrielle",
		"par trimestre",
		"trimestral",
	]),
	monthly: new RegExp(
		`/\\s?(?:mo|month|mnd|maand|monat|mois|mes)(?![\\p{L}])|${
			phraseRegex([
				"per month",
				"a month",
				"monthly",
				"every month",
				"each month",
				"per maand",
				"maandelijks",
				"pro monat",
				"monatlich",
				"par mois",
				"mensuel",
				"mensuelle",
				"al mes",
				"por mes",
				"mensual",
			]).source
		}`,
		"iu",
	),
	yearly: new RegExp(
		`/\\s?(?:yr|year|jaar|jahr|an|año)(?![\\p{L}])|${
			phraseRegex([
				"per year",
				"a year",
				"annual",
				"annually",
				"yearly",
				"every year",
				"per annum",
				"per jaar",
				"jaarlijks",
				"pro jahr",
				"jährlich",
				"par an",
				"annuel",
				"annuelle",
				"al año",
				"por año",
				"anual",
			]).source
		}`,
		"iu",
	),
	weekly: new RegExp(
		`/\\s?(?:wk|week|woche|semaine|semana)(?![\\p{L}])|${
			phraseRegex([
				"per week",
				"weekly",
				"every week",
				"wekelijks",
				"pro woche",
				"wöchentlich",
				"par semaine",
				"hebdomadaire",
				"por semana",
				"semanal",
			]).source
		}`,
		"iu",
	),
} as const;

/** A "total" line, which wins when a receipt names several amounts. */
export const TOTAL_PHRASE = phraseRegex([
	"total",
	"amount due",
	"amount paid",
	"amount charged",
	"totaal",
	"gesamt",
	"gesamtbetrag",
	"montant",
	"importe",
]);

/** Sender local parts that send bills. */
export const BILLING_LOCAL = /^(?:billing|invoices?|receipts?|payments?|accounts?)(?:[-_.+].*)?$/i;
export const NO_REPLY_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply)(?:[-_.+].*)?$/i;

/** Filename words of a document attachment, mapped to the document type they name. */
export const ATTACHMENT_WORDS: readonly { word: string; docType: "invoice" | "payment" | "credit" | "refund" }[] = [
	{ word: "invoice", docType: "invoice" },
	{ word: "factuur", docType: "invoice" },
	{ word: "rechnung", docType: "invoice" },
	{ word: "facture", docType: "invoice" },
	{ word: "factura", docType: "invoice" },
	{ word: "receipt", docType: "payment" },
	{ word: "recibo", docType: "payment" },
	{ word: "creditnota", docType: "credit" },
	{ word: "credit", docType: "credit" },
	{ word: "gutschrift", docType: "credit" },
	{ word: "avoir", docType: "credit" },
	{ word: "abono", docType: "credit" },
	{ word: "refund", docType: "refund" },
];

export const DOCUMENT_DATE_LABEL = phraseRegex([
	"invoice date",
	"date paid",
	"payment date",
	"receipt date",
	"date of issue",
	"issue date",
	"refund date",
	"credit note date",
	"factuurdatum",
	"betaaldatum",
	"rechnungsdatum",
	"zahlungsdatum",
	"ausstellungsdatum",
	"date de facture",
	"date de paiement",
	"date d'émission",
	"fecha de factura",
	"fecha de pago",
	"fecha de emisión",
]);

export const PERIOD_LABEL = phraseRegex([
	"billing period",
	"service period",
	"for the period",
	"period",
	"from",
	"factuurperiode",
	"periode",
	"abrechnungszeitraum",
	"zeitraum",
	"période de facturation",
	"période",
	"período",
	"periodo",
]);

/** Display-name words that say who sent the mail rather than which vendor it is. */
export const VENDOR_NOISE = phraseRegex([
	"billing",
	"team",
	"payments",
	"payment",
	"receipts",
	"invoices",
	"no-reply",
	"noreply",
	"do not reply",
	"accounts",
]);
