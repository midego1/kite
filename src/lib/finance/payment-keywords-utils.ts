import { phraseRegex } from "./keywords-utils";

/**
 * The phrases that mark mail as selling rather than billing (spec §25.1), in English, Dutch, German, French and
 * Spanish. A price in sales copy is not a payment, so these block a document type read from the body, and any type on
 * list mail.
 */
export const MARKETING_PHRASE = phraseRegex([
	"sale",
	"sale ends",
	"shop now",
	"buy now",
	"order now",
	"limited time",
	"limited offer",
	"special offer",
	"promo code",
	"promo",
	"coupon",
	"discount code",
	"deal",
	"deals",
	"black friday",
	"cyber monday",
	"free shipping",
	"save up to",
	"korting",
	"uitverkoop",
	"aanbieding",
	"rabatt",
	"angebot",
	"gutscheincode",
	"soldes",
	"réduction",
	"code promo",
	"offre spéciale",
	"oferta",
	"descuento",
	"rebajas",
]);

/** A percentage discount ("20% off", "30% korting"), which `phraseRegex` cannot express as a literal. */
export const PERCENT_OFF =
	/(?:^|[^\p{L}\p{N}])\d{1,2}\s?%\s?(?:off|korting|rabatt|de réduction|de descuento)(?![\p{L}])/iu;

/** A labelled money line: what a receipt or invoice says next to its amount. */
export const MONEY_LABEL = phraseRegex([
	"amount paid",
	"total paid",
	"total charged",
	"amount charged",
	"grand total",
	"amount due",
	"balance due",
	"total due",
	"you paid",
	"refund amount",
	"amount refunded",
	"credit amount",
	"betaald bedrag",
	"totaalbedrag",
	"te betalen",
	"gesamtbetrag",
	"rechnungsbetrag",
	"bezahlter betrag",
	"montant payé",
	"montant total",
	"montant dû",
	"total pagado",
	"importe total",
	"importe pagado",
]);

/**
 * A receipt, invoice or order number: a document word followed by a code of four or more letters and digits with at
 * least one digit, so "invoice today" is not a number.
 */
export const DOCUMENT_NUMBER =
	/(?:receipt|invoice|order|transaction|factuur|rechnung|facture|factura|recibo|bestelling)\s*(?:no\.?|number|nr\.?|nummer|n°|nº|#|id)?\s*[:#]?\s*\[?#?(?=[A-Z-]{0,40}\d)[A-Z0-9][A-Z0-9-]{3,40}/iu;

/** A bracketed reference such as "[#1114-6093]" in a subject. */
export const BRACKETED_NUMBER = /\[#?(?=[A-Z-]{0,40}\d)[A-Z0-9][A-Z0-9-]{3,40}\]/iu;

/**
 * Wording that says a bill is still owed, which turns a "paid" match into an open invoice: "has not been paid",
 * "nog niet betaald", "noch nicht bezahlt", "pas encore payé", "aún no se ha pagado". Balance words such as
 * "outstanding" or "openstaand" are left out: receipts print "outstanding balance: €0.00".
 */
export const UNPAID_PHRASE = phraseRegex([
	"not been paid",
	"not yet paid",
	"not paid",
	"unpaid",
	"nog niet betaald",
	"niet betaald",
	"onbetaald",
	"noch nicht bezahlt",
	"nicht bezahlt",
	"unbezahlt",
	"pas encore payé",
	"pas été payée",
	"pas été payé",
	"non payé",
	"non payée",
	"impayé",
	"impayée",
	"no ha sido pagado",
	"no ha sido pagada",
	"aún no se ha pagado",
	"no pagado",
	"pendiente de pago",
]);

/** A label that says the amount next to it was paid: a receipt, even when it also mentions an unpaid balance. */
export const PAID_LABEL = phraseRegex([
	"amount paid",
	"total paid",
	"you paid",
	"amount charged",
	"betaald bedrag",
	"bezahlter betrag",
	"montant payé",
	"importe pagado",
	"total pagado",
]);

/** Payment reminders and dunning, which ask for money rather than confirm it: an open invoice, never a payment. */
export const REMINDER_PHRASE = phraseRegex([
	"reminder",
	"payment reminder",
	"overdue",
	"final notice",
	"herinnering",
	"betalingsherinnering",
	"aanmaning",
	"mahnung",
	"zahlungserinnerung",
	"erinnerung",
	"relance",
	"rappel",
	"recordatorio",
	"recordatorio de pago",
	"aviso de pago",
]);

/** A reply or forward ("Re:", "Fwd:", "AW:", "WG:", "Doorst:", "TR:", "RV:"): a copy of a document, not the document. */
export const REPLY_OR_FORWARD = /^\s*(?:re|fw|fwd|aw|wg|antw|doorst|tr|rv|sv|vs|réf)\s*(?:\[\d{1,3}\])?\s*:/iu;

/** Mail providers anyone can sign up to: their senders are people, so the domain says nothing about a vendor. */
export const FREE_MAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"msn.com",
	"yahoo.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"zoho.com",
	"gmx.de",
	"gmx.net",
	"web.de",
	"t-online.de",
	"ziggo.nl",
	"kpnmail.nl",
	"hetnet.nl",
	"planet.nl",
	"orange.fr",
	"free.fr",
	"laposte.net",
	"yandex.ru",
	"mail.ru",
]);
