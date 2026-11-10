/**
 * The categories of a payment (spec §27): a small fixed set, set by code only where one category is obvious and
 * changed by hand in the Payments tab. No category is `null`, never a value outside this list; anything else (the
 * model's text, a request body, a restored backup) is refused or read as none.
 */
export const PAYMENT_CATEGORIES = [
	"software",
	"shopping",
	"food",
	"travel",
	"utilities",
	"health",
	"entertainment",
	"education",
	"other",
] as const;

export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number];

/** A stored or submitted value as a category, or null for anything that is not one. */
export function paymentCategoryOf(value: unknown): PaymentCategory | null {
	return typeof value === "string" && (PAYMENT_CATEGORIES as readonly string[]).includes(value)
		? (value as PaymentCategory)
		: null;
}

/**
 * Words that make one category obvious, in English and Dutch with the common German and French ones. They are read in
 * the vendor, the subject and the sender's domain only (never the body, where sales copy and line items mention
 * everything), and a mail that matches two categories gets none. Shopping's words are generic ("your order" is on a
 * pizza receipt too), so they count only when no other category matched.
 */
const CUES: readonly (readonly [Exclude<PaymentCategory, "other" | "shopping">, RegExp])[] = [
	[
		"software",
		/\b(?:software|saas|cloud|hosting|domain names?|domeinnamen?|vps|licen[cs]es?|licentie|github|gitlab|aws|azure|google workspace|microsoft 365|office 365|adobe|dropbox|figma|jetbrains|openai|anthropic|namecheap|godaddy|cloudflare|digitalocean|hetzner|vercel|netlify)\b/,
	],
	[
		"food",
		/\b(?:restaurants?|pizza|pizzeria|sushi|burgers?|caf[eé]|coffee|koffie|bakery|bakkerij|bezorg\w*|maaltijd\w*|meals?|takeaway|take-away|thuisbezorgd|uber ?eats|deliveroo|just eat|picnic|albert heijn|jumbo|lidl|aldi|hellofresh|grocer(?:y|ies)|supermarkt|boodschappen)\b/,
	],
	[
		"travel",
		/\b(?:flights?|vlucht\w*|airlines?|airways|boarding pass|itinerary|reisschema|hotels?|hostel|booking\.com|airbnb|expedia|trainline|ns reizigers|ov-chipkaart|train tickets?|treinkaartjes?|treinticket|car rental|autohuur|sixt|hertz|klm|ryanair|easyjet|transavia|lufthansa|flixbus|taxi|uber)\b/,
	],
	[
		"utilities",
		/\b(?:electricity|energy|energie|stroom|vattenfall|eneco|essent|vitens|broadband|glasvezel|fib(?:re|er)|telecom|kpn|ziggo|odido|t-mobile|vodafone|sim only|mobiele?)\b/,
	],
	[
		"health",
		/\b(?:pharmacy|apotheek|dentist|tandarts|doctor|huisarts|clinic|kliniek|physio\w*|fysio\w*|optician|opticien|hospital|ziekenhuis|zorgverzeker\w*|health insurance|specsavers)\b/,
	],
	[
		"entertainment",
		/\b(?:cinema|bioscoop|path[eé]|concert|festival|theat(?:er|re)|museum|ticketmaster|eventbrite|spotify|netflix|disney|steam|playstation|xbox|nintendo|games?|gaming|twitch)\b/,
	],
	[
		"education",
		/\b(?:courses?|cursus|tuition|collegegeld|udemy|coursera|university|universiteit|workshop|webinar|training)\b/,
	],
];

const SHOPPING =
	/\b(?:order confirmation|bestelbevestiging|your order|uw bestelling|bestelling|webshop|webwinkel|shipped|verzonden|parcel|pakket|bol\.com|amazon|coolblue|ikea|zalando|wehkamp|mediamarkt|aliexpress|ebay|etsy)\b/;

export type CategoryCues = {
	vendor: string;
	subject: string | null;
	/** The registrable domain or address the mail came from. */
	sender: string | null;
};

const MAX_CUE_TEXT = 400;

/**
 * The category one message makes obvious, or null (spec §27.2): exactly one category's words in the vendor, the subject
 * and the sender's domain. Pure and deterministic; the model never sets a category.
 */
export function categoryOf(cues: CategoryCues): PaymentCategory | null {
	const text = `${cues.vendor}\n${cues.subject ?? ""}\n${cues.sender ?? ""}`.slice(0, MAX_CUE_TEXT).toLowerCase();
	const matched = CUES.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
	if (matched.length === 0) return SHOPPING.test(text) ? "shopping" : null;
	return matched.length === 1 ? matched[0]! : null;
}
