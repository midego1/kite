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

type Cued = Exclude<PaymentCategory, "other">;

/**
 * Known businesses, read in the vendor and the sender's domain only and tried in order, the first match winning: a
 * brand names its category outright, so "Uber Eats" is food (it comes before "uber", which is travel) and a shop's
 * subject can name any product ("Training shoes", "Cloud Atlas") without changing the shop's category.
 */
const BRANDS: readonly (readonly [Cued, RegExp])[] = [
	[
		"food",
		/\b(?:uber ?eats|thuisbezorgd|deliveroo|just eat|picnic|albert heijn|jumbo|lidl|aldi|hellofresh|domino'?s|mcdonald'?s|starbucks)\b/,
	],
	[
		"travel",
		/\b(?:booking\.com|airbnb|expedia|trainline|ns reizigers|ov-chipkaart|9292|sixt|hertz|klm|ryanair|easyjet|transavia|lufthansa|flixbus|uber|bolt)\b/,
	],
	[
		"shopping",
		/\b(?:bol\.com|amazon|coolblue|mediamarkt|ikea|zalando|wehkamp|aliexpress|ebay|etsy|decathlon|h&m|hema)\b/,
	],
	[
		"software",
		/\b(?:github|gitlab|aws|azure|google workspace|microsoft 365|office 365|adobe|dropbox|figma|jetbrains|openai|anthropic|namecheap|godaddy|cloudflare|digitalocean|hetzner|vercel|netlify)\b/,
	],
	["utilities", /\b(?:vattenfall|eneco|essent|vitens|kpn|ziggo|odido|t-mobile|vodafone)\b/],
	["health", /\b(?:etos|specsavers)\b/],
	[
		"entertainment",
		/\b(?:path[eé]|ticketmaster|eventbrite|spotify|netflix|disney|steam|playstation|xbox|nintendo|twitch)\b/,
	],
	["education", /\b(?:coursera|udemy)\b/],
];

/**
 * Business words that make one category obvious, read in the vendor and the sender's domain only: "Acme Hosting" is
 * software, "Pizzeria Roma" is food. Two categories in one name ("Pizza Hosting", "The Cloud Bakery") give none.
 */
const BUSINESS: readonly (readonly [Cued, RegExp])[] = [
	["software", /\b(?:software|saas|cloud|hosting|domain names?|domeinnamen?|vps|licen[cs]es?|licentie)\b/],
	[
		"food",
		/\b(?:restaurants?|pizza|pizzeria|sushi|burgers?|caf[eé]|coffee|koffie|bakery|bakkerij|takeaway|take-away|grocer(?:y|ies)|supermarkt)\b/,
	],
	["travel", /\b(?:flights?|vlucht\w*|airlines?|airways|hotels?|hostel|car rental|autohuur|taxi)\b/],
	["utilities", /\b(?:electricity|energy|energie|stroom|broadband|glasvezel|fib(?:re|er)|telecom)\b/],
	[
		"health",
		/\b(?:pharmacy|apotheek|dentist|tandarts|doctor|huisarts|clinic|kliniek|physio\w*|fysio\w*|optician|opticien|hospital|ziekenhuis|zorgverzeker\w*|health insurance)\b/,
	],
	["entertainment", /\b(?:cinema|bioscoop|concert|festival|theat(?:er|re)|museum)\b/],
	[
		"education",
		/\b(?:courses?|cursus|tuition|collegegeld|university|universiteit|workshop|webinar|training|academy)\b/,
	],
];

/**
 * What a subject may say on its own: a few phrases that name the document, not a product. A subject lists what was
 * bought, so common nouns ("training", "cloud", "games") are not cues here, and a subject matches only when no vendor
 * or domain word did.
 */
const SUBJECT: readonly (readonly [Cued, RegExp])[] = [
	[
		"travel",
		/\b(?:flight receipt|boarding pass|itinerary|vluchtbevestiging|reisschema|hotel reservation|hotelreservering)\b/,
	],
	["utilities", /\b(?:electricity bill|energy bill|energienota|jaarnota)\b/],
	["software", /\b(?:domain renewal|domeinnaam|hosting invoice)\b/],
];

/** Generic shop words, which count only when nothing else matched ("your order" is on a pizza receipt too). */
const SHOPPING =
	/\b(?:order confirmation|bestelbevestiging|your order|uw bestelling|bestelling|webshop|webwinkel|shipped|verzonden|parcel|pakket)\b/;

export type CategoryCues = {
	vendor: string;
	subject: string | null;
	/** The registrable domain or address the mail came from. */
	sender: string | null;
};

const MAX_CUE_TEXT = 400;

/** The one category whose pattern matches, or null when none or several do. */
function single(table: readonly (readonly [Cued, RegExp])[], text: string): Cued | null | undefined {
	const matched = table.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
	return matched.length === 0 ? undefined : matched.length === 1 ? matched[0]! : null;
}

/**
 * The category one message makes obvious, or null (spec §27.2), in this order: a known business in the vendor or the
 * sender's domain; else exactly one category's business words there; else a document phrase in the subject; else
 * generic shop words. The body is never read and the model never sets a category. Pure and deterministic.
 */
export function categoryOf(cues: CategoryCues): PaymentCategory | null {
	const name = `${cues.vendor}\n${cues.sender ?? ""}`.slice(0, MAX_CUE_TEXT).toLowerCase();
	const subject = (cues.subject ?? "").slice(0, MAX_CUE_TEXT).toLowerCase();
	const brand = BRANDS.find(([, pattern]) => pattern.test(name));
	if (brand) return brand[0];
	const business = single(BUSINESS, name);
	if (business !== undefined) return business;
	const phrase = single(SUBJECT, subject);
	if (phrase !== undefined) return phrase;
	return SHOPPING.test(subject) ? "shopping" : null;
}
