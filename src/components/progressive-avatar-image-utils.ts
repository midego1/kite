export function getAvatarPreviewUrl(src: string): string {
	const url = new URL(src, "http://localhost");
	url.searchParams.set("variant", "preview");
	return `${url.pathname}${url.search}`;
}

/** Matches the avatar route's `Cache-Control: max-age` for versioned (`?v=`) URLs, which are immutable. */
export const AVATAR_LOADED_TTL_MS = 31_536_000 * 1000;
export const AVATAR_LOADED_STORAGE_KEY = "kite:avatar-loaded";
const AVATAR_LOADED_MAX_ENTRIES = 200;

type AvatarLoadedStore = Pick<Storage, "getItem" | "setItem">;

function browserStore(): AvatarLoadedStore | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** Only a versioned URL is immutable, so only its full image is guaranteed to come from the browser cache again. */
export function isRememberableAvatar(src: string): boolean {
	return new URL(src, "http://localhost").searchParams.has("v");
}

function readLoaded(store: AvatarLoadedStore, now: number): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(store.getItem(AVATAR_LOADED_STORAGE_KEY) ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > now,
			),
		);
	} catch {
		return {};
	}
}

/** Whether this full avatar finished loading before and is still within the browser cache lifetime. */
export function wasAvatarLoaded(
	src: string,
	now = Date.now(),
	store: AvatarLoadedStore | null = browserStore(),
): boolean {
	if (!store || !isRememberableAvatar(src)) return false;
	return (readLoaded(store, now)[src] ?? 0) > now;
}

/** Remembers a fully loaded avatar so the next mount skips the blurred preview. Oldest entries go first. */
export function rememberAvatarLoaded(
	src: string,
	now = Date.now(),
	store: AvatarLoadedStore | null = browserStore(),
): void {
	if (!store || !isRememberableAvatar(src)) return;
	const loaded = readLoaded(store, now);
	delete loaded[src];
	loaded[src] = now + AVATAR_LOADED_TTL_MS;
	const entries = Object.entries(loaded).slice(-AVATAR_LOADED_MAX_ENTRIES);
	try {
		store.setItem(AVATAR_LOADED_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
	} catch {
		// Storage can be full or blocked; the preview then shows as before.
	}
}
