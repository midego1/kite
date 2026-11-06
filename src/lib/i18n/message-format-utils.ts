import type { MessageValues } from "./i18n-types";

/**
 * The small part of ICU MessageFormat the interface needs: `{name}` and
 * `{name, plural, =0 {none} one {# file} other {# files}}`, where `#` is the formatted number.
 */
type MessageNode =
	| string
	| { kind: "value"; name: string }
	| { kind: "count" }
	| { kind: "plural"; name: string; forms: Record<string, MessageNode[]> };

export interface MessageFormats {
	plural: Intl.PluralRules;
	number: Intl.NumberFormat;
}

const PLURAL_ARGUMENT = /^\s*([\w-]+)\s*,\s*plural\s*,/;
const PLURAL_FORM = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/;

/** Where the brace opened just before `start` closes; -1 when it never does. */
function closingBrace(text: string, start: number): number {
	let depth = 1;
	for (let index = start; index < text.length; index += 1) {
		if (text[index] === "{") depth += 1;
		if (text[index] === "}" && --depth === 0) return index;
	}
	return -1;
}

function parseForms(text: string): Record<string, MessageNode[]> | null {
	const forms: Record<string, MessageNode[]> = {};
	let rest = text;
	while (rest.trim()) {
		const form = PLURAL_FORM.exec(rest);
		if (!form) return null;
		const end = closingBrace(rest, form[0].length);
		if (end < 0) return null;
		forms[form[1]!] = parseNodes(rest.slice(form[0].length, end), true) ?? [];
		rest = rest.slice(end + 1);
	}
	return "other" in forms ? forms : null;
}

function parseArgument(body: string): MessageNode | null {
	const plural = PLURAL_ARGUMENT.exec(body);
	if (plural) {
		const forms = parseForms(body.slice(plural[0].length));
		return forms && { kind: "plural", name: plural[1]!, forms };
	}
	const name = body.trim();
	return /^[\w-]+$/.test(name) ? { kind: "value", name } : null;
}

function parseNodes(text: string, inPlural: boolean): MessageNode[] | null {
	const nodes: MessageNode[] = [];
	let literal = "";
	const flush = () => {
		if (literal) nodes.push(literal);
		literal = "";
	};
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if (character === "#" && inPlural) {
			flush();
			nodes.push({ kind: "count" });
		} else if (character === "{") {
			const end = closingBrace(text, index + 1);
			if (end < 0) return null;
			const node = parseArgument(text.slice(index + 1, end));
			if (!node) return null;
			flush();
			nodes.push(node);
			index = end;
		} else {
			literal += character;
		}
	}
	flush();
	return nodes;
}

const parsed = new Map<string, MessageNode[] | null>();

function parseMessage(message: string): MessageNode[] | null {
	let nodes = parsed.get(message);
	if (nodes === undefined) {
		nodes = parseNodes(message, false);
		parsed.set(message, nodes);
	}
	return nodes;
}

function formatValue(value: string | number, formats: MessageFormats): string {
	return typeof value === "number" ? formats.number.format(value) : value;
}

function formatNodes(
	nodes: MessageNode[],
	values: MessageValues,
	formats: MessageFormats,
	count: number | undefined,
): string {
	let text = "";
	for (const node of nodes) {
		if (typeof node === "string") text += node;
		else if (node.kind === "count") text += count === undefined ? "#" : formats.number.format(count);
		else if (node.kind === "value")
			text += node.name in values ? formatValue(values[node.name]!, formats) : `{${node.name}}`;
		else {
			const amount = Number(values[node.name]);
			const form = node.forms[`=${amount}`] ?? node.forms[formats.plural.select(amount)] ?? node.forms.other!;
			text += formatNodes(form, values, formats, amount);
		}
	}
	return text;
}

/** Fills in a message. A malformed one comes back as written, so a catalog typo can never break a page. */
export function formatMessage(message: string, values: MessageValues, formats: MessageFormats): string {
	const nodes = parseMessage(message);
	return nodes ? formatNodes(nodes, values, formats, undefined) : message;
}

function collect(nodes: MessageNode[], names: Set<string>, categories: Set<string>) {
	for (const node of nodes) {
		if (typeof node === "string" || node.kind === "count") continue;
		names.add(node.name);
		if (node.kind !== "plural") continue;
		for (const [category, form] of Object.entries(node.forms)) {
			categories.add(category);
			collect(form, names, categories);
		}
	}
}

/** The placeholders and plural forms of a message, or null when it is malformed; for the catalog checks. */
export function describeMessage(message: string): { names: string[]; categories: string[] } | null {
	const nodes = parseMessage(message);
	if (!nodes) return null;
	const names = new Set<string>();
	const categories = new Set<string>();
	collect(nodes, names, categories);
	return { names: [...names].sort(), categories: [...categories].sort() };
}
