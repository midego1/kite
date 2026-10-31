import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * What `/<([^>]+)>$/` would capture, found by index: the regex retries from every `<` and is quadratic on a long
 * run of them, and display names reach it unbounded from older or API-written rows.
 */
function angleAddress(value: string): string | null {
	if (!value.endsWith(">")) return null;
	const open = value.indexOf("<", value.lastIndexOf(">", value.length - 2) + 1);
	return open >= 0 && open < value.length - 2 ? value.slice(open + 1, -1) : null;
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function parseAddress(address: string): { local: string; domain: string } | null {
	const normalized = angleAddress(address.trim()) ?? address.trim();
	const match = normalized.match(/^([^@\s]+)@([^@\s]+)$/);
	if (!match) return null;
	return { local: match[1].toLowerCase(), domain: match[2].toLowerCase() };
}
