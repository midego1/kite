export function getAvatarPreviewUrl(src: string): string {
	const url = new URL(src, "http://localhost");
	url.searchParams.set("variant", "preview");
	return `${url.pathname}${url.search}`;
}

/** Matches the avatar route's `Cache-Control: max-age` for versioned (`?v=`) URLs, which are immutable. */
export const AVATAR_LOADED_TTL_MS = 31_536_000 * 1000;
export const AVATAR_LOADED_STORAGE_KEY = "kite:avatar-loaded";
const AVATAR_LOADED_MAX_ENTRIES = 200;

type AvatarLoadedStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): AvatarLoadedStore | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** Only a versioned URL is immutable, so only its full image is guaranteed to come from the browser cache again. */
function isRememberableAvatar(src: string): boolean {
	return new URL(src, "http://localhost").searchParams.has("v");
}

// Every avatar on screen asks, so the stored list is parsed again only when its text changed.
let parsedFrom: string | null = null;
let parsedLoaded: Record<string, number> = {};

function parseLoaded(raw: string | null): Record<string, number> {
	if (raw === parsedFrom) return parsedLoaded;
	let loaded: Record<string, number> = {};
	try {
		const parsed: unknown = JSON.parse(raw ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			loaded = Object.fromEntries(
				Object.entries(parsed as Record<string, unknown>).filter(
					(entry): entry is [string, number] => typeof entry[1] === "number",
				),
			);
		}
	} catch {
		// Corrupt storage reads as empty and is replaced by the next remembered avatar.
	}
	parsedFrom = raw;
	parsedLoaded = loaded;
	return loaded;
}

/** Forgets every remembered avatar, as the next account on this browser must not inherit them. */
export function forgetLoadedAvatars(store: Pick<Storage, "removeItem"> | null = browserStore()): void {
	parsedFrom = null;
	parsedLoaded = {};
	try {
		store?.removeItem(AVATAR_LOADED_STORAGE_KEY);
	} catch {
		// Blocked storage has nothing to forget.
	}
}

/** Whether this full avatar finished loading before and is still within the browser cache lifetime. */
export function wasAvatarLoaded(
	src: string,
	now = Date.now(),
	store: AvatarLoadedStore | null = browserStore(),
): boolean {
	if (!store || !isRememberableAvatar(src)) return false;
	return (parseLoaded(store.getItem(AVATAR_LOADED_STORAGE_KEY))[src] ?? 0) > now;
}

/** Remembers a fully loaded avatar so the next mount skips the blurred preview. Oldest entries go first. */
export function rememberAvatarLoaded(
	src: string,
	now = Date.now(),
	store: AvatarLoadedStore | null = browserStore(),
): void {
	if (!store || !isRememberableAvatar(src)) return;
	const loaded = Object.entries(parseLoaded(store.getItem(AVATAR_LOADED_STORAGE_KEY))).filter(
		([key, expires]) => key !== src && expires > now,
	);
	const entries = [...loaded, [src, now + AVATAR_LOADED_TTL_MS] as const].slice(-AVATAR_LOADED_MAX_ENTRIES);
	try {
		const next = Object.fromEntries(entries);
		const raw = JSON.stringify(next);
		store.setItem(AVATAR_LOADED_STORAGE_KEY, raw);
		parsedFrom = raw;
		parsedLoaded = next;
	} catch {
		// Storage can be full or blocked; the preview then shows as before.
	}
}
