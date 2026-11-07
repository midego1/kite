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
