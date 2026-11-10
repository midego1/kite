/**
 * A small, hardened XML reader for WebDAV `207 Multi-Status` answers. It reads elements, attributes, text and
 * CDATA and resolves namespaces; it refuses every document type declaration, so no entity (internal or
 * external) is ever defined or expanded, and only the five predefined entities and character references are
 * decoded. Depth, element count and input size are capped, so a hostile server cannot make it work hard.
 */

export class WebdavXmlError extends Error {}

/** @public Exercised by the unit tests. */
export const XML_LIMITS = { maxChars: 8 * 1024 * 1024, maxDepth: 32, maxElements: 100_000 };

type XmlElement = { ns: string; name: string; children: XmlElement[]; text: string };

const DAV = "DAV:";
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(/&([^;&\s]{1,10});/g, (_, entity: string) => {
		if (entity in PREDEFINED) return PREDEFINED[entity];
		const code = /^#x[0-9a-f]{1,6}$/i.test(entity)
			? parseInt(entity.slice(2), 16)
			: /^#\d{1,7}$/.test(entity)
				? Number(entity.slice(1))
				: NaN;
		if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
			throw new WebdavXmlError(`Unknown entity &${entity};`);
		return String.fromCodePoint(code);
	});
}

type Frame = { element: XmlElement; qname: string; scope: Map<string, string> };

/** `prefix:local` resolved against the declarations in scope; an undeclared prefix resolves to no namespace. */
function resolve(qname: string, scope: Map<string, string>): { ns: string; name: string } {
	const colon = qname.indexOf(":");
	if (colon < 0) return { ns: scope.get("") ?? "", name: qname };
	return { ns: scope.get(qname.slice(0, colon)) ?? "", name: qname.slice(colon + 1) };
}

const ATTRIBUTE = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y;

/** The attributes of a start tag and whether it closes itself. */
function readAttributes(tag: string): { attributes: [string, string][]; selfClosing: boolean } {
	const selfClosing = tag.endsWith("/");
	const body = selfClosing ? tag.slice(0, -1) : tag;
	const attributes: [string, string][] = [];
	ATTRIBUTE.lastIndex = 0;
	while (ATTRIBUTE.lastIndex < body.length) {
		if (!body.slice(ATTRIBUTE.lastIndex).trim()) break;
		const match = ATTRIBUTE.exec(body);
		if (!match || !NAME.test(match[1])) throw new WebdavXmlError("Malformed attribute");
		attributes.push([match[1], decodeEntities(match[3] ?? match[4] ?? "")]);
	}
	return { attributes, selfClosing };
}

function scopeFor(parent: Map<string, string>, attributes: [string, string][]): Map<string, string> {
	const declarations = attributes.filter(([name]) => name === "xmlns" || name.startsWith("xmlns:"));
	if (!declarations.length) return parent;
	const scope = new Map(parent);
	for (const [name, value] of declarations) scope.set(name === "xmlns" ? "" : name.slice(6), value);
	return scope;
}

class XmlReader {
	private index = 0;
	private elements = 0;
	private readonly stack: Frame[] = [];
	private root: XmlElement | null = null;

	constructor(private readonly source: string) {}

	parse(): XmlElement {
		while (this.index < this.source.length) {
			const next = this.source.indexOf("<", this.index);
			const end = next < 0 ? this.source.length : next;
			if (end > this.index) this.text(this.source.slice(this.index, end));
			if (next < 0) break;
			this.index = next;
			this.markup();
		}
		if (this.stack.length || !this.root) throw new WebdavXmlError("Unexpected end of document");
		return this.root;
	}

	private until(marker: string, from: number): number {
		const at = this.source.indexOf(marker, from);
		if (at < 0) throw new WebdavXmlError("Unexpected end of document");
		return at;
	}

	private text(raw: string) {
		const top = this.stack.at(-1);
		if (top) top.element.text += decodeEntities(raw);
		else if (raw.trim()) throw new WebdavXmlError("Text outside the root element");
	}

	private markup() {
		const { source, index } = this;
		if (source.startsWith("<?", index)) this.index = this.until("?>", index + 2) + 2;
		else if (source.startsWith("<!--", index)) this.index = this.until("-->", index + 4) + 3;
		else if (source.startsWith("<![CDATA[", index)) {
			const end = this.until("]]>", index + 9);
			const top = this.stack.at(-1);
			if (!top) throw new WebdavXmlError("CDATA outside the root element");
			top.element.text += source.slice(index + 9, end);
			this.index = end + 3;
		} else if (source.startsWith("<!", index))
			// DOCTYPE, ENTITY and anything else that could define entities or fetch a DTD.
			throw new WebdavXmlError("Document type declarations are not allowed");
		else if (source.startsWith("</", index)) this.close();
		else this.open();
	}

	private close() {
		const end = this.until(">", this.index);
		const qname = this.source.slice(this.index + 2, end).trim();
		const frame = this.stack.pop();
		if (!frame || frame.qname !== qname) throw new WebdavXmlError("Mismatched closing tag");
		this.index = end + 1;
	}

	private open() {
		const end = this.until(">", this.index);
		const tag = this.source.slice(this.index + 1, end);
		this.index = end + 1;
		const qname = /^[^\s/>]+/.exec(tag)?.[0] ?? "";
		if (!NAME.test(qname)) throw new WebdavXmlError("Malformed tag");
		if (this.root && !this.stack.length) throw new WebdavXmlError("More than one root element");
		if (++this.elements > XML_LIMITS.maxElements) throw new WebdavXmlError("Too many elements");
		if (this.stack.length >= XML_LIMITS.maxDepth) throw new WebdavXmlError("Too deeply nested");
		const { attributes, selfClosing } = readAttributes(tag.slice(qname.length));
		const parent = this.stack.at(-1);
		const scope = scopeFor(parent?.scope ?? new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]), attributes);
		const element: XmlElement = { ...resolve(qname, scope), children: [], text: "" };
		if (parent) parent.element.children.push(element);
		else this.root = element;
		if (!selfClosing) this.stack.push({ element, qname, scope });
	}
}

/** @public Exercised by the unit tests. Parses a whole document into its root element. Throws `WebdavXmlError` for anything malformed or refused. */
export function parseXml(source: string): XmlElement {
	if (source.length > XML_LIMITS.maxChars) throw new WebdavXmlError("The answer is too large");
	return new XmlReader(source.replace(/^﻿/, "")).parse();
}

/** One `<response>` of a multistatus: its href and the properties of its successful `<propstat>`. */
export type DavEntry = {
	href: string;
	collection: boolean;
	size: number | null;
	contentType: string | null;
	lastModified: string | null;
	etag: string | null;
	displayName: string | null;
};

/** Namespace-tolerant: `DAV:` elements under any prefix, and unqualified ones from servers that omit it. */
const isDav = (element: XmlElement, name: string) =>
	element.name.toLowerCase() === name && (element.ns === DAV || element.ns === "");
const child = (element: XmlElement, name: string) => element.children.find((item) => isDav(item, name));
const children = (element: XmlElement, name: string) => element.children.filter((item) => isDav(item, name));
const textOf = (element: XmlElement | undefined) => element?.text.trim() || null;

/** `HTTP/1.1 200 OK` → 200; a missing status counts as success, as some servers leave it out. */
function statusCode(element: XmlElement | undefined): number {
	const text = textOf(element);
	if (!text) return 200;
	return Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(text)?.[1] ?? 0);
}

const isSuccess = (code: number) => code >= 200 && code < 300;

function readSize(value: string | null): number | null {
	if (!value || !/^\d{1,16}$/.test(value)) return null;
	const size = Number(value);
	return Number.isSafeInteger(size) ? size : null;
}

function readDate(value: string | null): string | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function readEntry(response: XmlElement): DavEntry | null {
	const href = textOf(child(response, "href"));
	if (!href || !isSuccess(statusCode(child(response, "status")))) return null;
	const props = children(response, "propstat")
		.filter((propstat) => isSuccess(statusCode(child(propstat, "status"))))
		.flatMap((propstat) => children(propstat, "prop").flatMap((prop) => prop.children));
	const prop = (name: string) => props.find((item) => isDav(item, name));
	const resourceType = prop("resourcetype");
	return {
		href,
		collection: !!resourceType && !!child(resourceType, "collection"),
		size: readSize(textOf(prop("getcontentlength"))),
		contentType: textOf(prop("getcontenttype")),
		lastModified: readDate(textOf(prop("getlastmodified"))),
		etag: textOf(prop("getetag")),
		displayName: textOf(prop("displayname")),
	};
}

/** The entries of a `207 Multi-Status` body; responses without an href or with a failed status are skipped. */
export function parseMultistatus(source: string): DavEntry[] {
	const root = parseXml(source);
	if (!isDav(root, "multistatus")) throw new WebdavXmlError("Not a WebDAV multistatus answer");
	return children(root, "response")
		.map(readEntry)
		.filter((entry): entry is DavEntry => entry !== null);
}

/** The PROPFIND body: only the properties the listing needs, so servers do not compute expensive ones. */
export const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:getetag/><d:displayname/></d:prop></d:propfind>`;
