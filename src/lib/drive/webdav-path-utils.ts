import { isBlockedHost } from "@/lib/security/outbound-url";
import { isLoopbackHostname, type EndpointPolicy } from "@/lib/storage/endpoint-utils";
import { DRIVE_MAX_DEPTH, DRIVE_MAX_NAME_LENGTH } from "./name-utils";

/**
 * Paths inside a linked folder are decoded and relative to the folder the user linked: `/` is that folder,
 * `/Photos/2026` a folder below it. Every segment is checked, so a path can never climb out of the folder.
 */
export type MountPath = string;

const MAX_URL_LENGTH = 2048;
const MAX_PATH_LENGTH = 4096;
const BAD_SEGMENT = /[\u0000-\u001f\u007f\\]/;

const isSegment = (segment: string) =>
	segment.length > 0 &&
	segment.length <= DRIVE_MAX_NAME_LENGTH &&
	segment !== "." &&
	segment !== ".." &&
	!BAD_SEGMENT.test(segment);

/** @public Exercised by the unit tests. The segments of a usable path, or null. `""`, `/` and `/a/b/` are fine; `..`, `//` and control characters are not. */
export function mountPathSegments(value: unknown): string[] | null {
	if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) return null;
	const trimmed = value.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!trimmed) return [];
	const segments = trimmed.split("/");
	if (segments.length > DRIVE_MAX_DEPTH || !segments.every(isSegment)) return null;
	return segments;
}

/** The canonical form of a path (`/a/b`), or null when it is unusable. */
export function normalizeMountPath(value: unknown): MountPath | null {
	const segments = mountPathSegments(value);
	return segments ? `/${segments.join("/")}` : null;
}

export function joinMountPath(parent: MountPath, name: string): MountPath {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function parentMountPath(path: MountPath): MountPath {
	const at = path.lastIndexOf("/");
	return at <= 0 ? "/" : path.slice(0, at);
}

export function mountPathName(path: MountPath): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether `path` is `ancestor` or inside it, so a folder is never moved into itself. */
export function isWithinMountPath(path: MountPath, ancestor: MountPath): boolean {
	return ancestor === "/" || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** The server URL of a path below the linked folder; folders end in `/`, as WebDAV servers expect. */
export function mountUrl(base: URL, path: MountPath, folder = false): URL {
	const segments = mountPathSegments(path);
	if (!segments) throw new Error("Invalid path");
	const url = new URL(base.href);
	const encoded = segments.map((segment) => encodeURIComponent(segment)).join("/");
	url.pathname = `${url.pathname}${encoded}${folder && encoded ? "/" : ""}`;
	return url;
}

function decodedSegments(pathname: string): string[] | null {
	try {
		return pathname
			.split("/")
			.filter(Boolean)
			.map((segment) => decodeURIComponent(segment));
	} catch {
		return null;
	}
}

/**
 * The path a PROPFIND `href` names, relative to the linked folder, or null when it is malformed, on another
 * origin or outside the folder. Hrefs are compared decoded, since servers differ in what they escape.
 */
export function hrefToMountPath(href: string, base: URL): MountPath | null {
	let url: URL;
	try {
		url = new URL(href, base);
	} catch {
		return null;
	}
	if (url.origin !== base.origin) return null;
	const baseSegments = decodedSegments(base.pathname);
	const segments = decodedSegments(url.pathname);
	if (!baseSegments || !segments || segments.length < baseSegments.length) return null;
	if (baseSegments.some((segment, index) => segments[index] !== segment)) return null;
	return normalizeMountPath(segments.slice(baseSegments.length).join("/"));
}

export type ParsedWebdavUrl = { url: URL; error: null } | { url: null; error: string };

/**
 * The folder URL a user typed: http(s), no credentials, query or fragment, and always ending in `/` so paths
 * below it resolve inside it.
 */
export function parseWebdavUrl(value: unknown): ParsedWebdavUrl {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) return { url: null, error: "Enter the folder's WebDAV address" };
	if (text.length > MAX_URL_LENGTH) return { url: null, error: "The address is too long" };
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { url: null, error: "Enter a full address, starting with https://" };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		return { url: null, error: "The address must start with https://" };
	if (url.username || url.password) return { url: null, error: "Leave the username and password out of the address" };
	if (url.search) return { url: null, error: "The address cannot contain a query (?…)" };
	if (decodedSegments(url.pathname) === null) return { url: null, error: "The address is not valid" };
	url.hash = "";
	if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
	return { url, error: null };
}

/**
 * The literal half of the address guard, under the same policy as object storage stores: public https hosts
 * only, unless `STORAGE_ALLOW_INSECURE_ENDPOINT` (outside production: http and loopback, for the e2e fake) or,
 * on the Node server, `STORAGE_ALLOW_PRIVATE_ENDPOINTS` (a NAS on the LAN) says otherwise.
 */
export function webdavAddressProblem(url: URL, policy: EndpointPolicy): string | null {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (!hostname) return "Enter the folder's WebDAV address";
	const loopback = isLoopbackHostname(hostname);
	const local = loopback || isBlockedHost(hostname);
	if (local && !(policy.allowPrivate || (loopback && policy.allowInsecure)))
		return "Private and local addresses cannot be linked";
	if (url.protocol === "http:" && !(policy.allowInsecure || (policy.allowPrivate && local)))
		return "The address must use https";
	return null;
}

/** Whether the host is a local one a flag allowed, so resolving it to look for private addresses is moot. */
export function isAllowedLocalAddress(url: URL, policy: EndpointPolicy): boolean {
	if (policy.allowPrivate) return true;
	return policy.allowInsecure && isLoopbackHostname(url.hostname.replace(/^\[|\]$/g, ""));
}
