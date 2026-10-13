import { authFetch } from "@/lib/auth/client";
import type { Message } from "@/hooks/types";
import type { CachedMessageDetail } from "./detail-cache-types";
import { MESSAGE_DETAIL_CACHE_LIMIT, readRecent, rememberRecent } from "./detail-cache-utils";

const detailCache = new Map<string, CachedMessageDetail>();
const detailRequests = new Map<string, Promise<CachedMessageDetail>>();

function remember(messageId: string, detail: CachedMessageDetail): void {
	rememberRecent(detailCache, messageId, detail, MESSAGE_DETAIL_CACHE_LIMIT);
}

export function clearMessageDetailCache() {
	detailCache.clear();
	detailRequests.clear();
}

export function getCachedMessageDetail(messageId: string): CachedMessageDetail | undefined {
	return readRecent(detailCache, messageId);
}

export function setCachedMessageRead(messageId: string, read: boolean): void {
	const cached = detailCache.get(messageId);
	if (cached?.message) detailCache.set(messageId, { ...cached, message: { ...cached.message, read } });
}

export function primeMessageDetail(message: Message): void {
	if (message.textBody === undefined && message.htmlBody === undefined) return;
	remember(message.id, {
		message,
		body: { textBody: message.textBody ?? null, htmlBody: message.htmlBody ?? null },
	});
}

export async function fetchCachedMessageDetail(messageId: string, force = false): Promise<CachedMessageDetail> {
	if (!force && detailCache.has(messageId)) return readRecent(detailCache, messageId) ?? {};
	if (!force && detailRequests.has(messageId)) return detailRequests.get(messageId) ?? {};
	const request = authFetch(`/api/messages/${messageId}`)
		.then((response) => response.json() as Promise<CachedMessageDetail>)
		.then((data) => {
			remember(messageId, data);
			return data;
		})
		.finally(() => detailRequests.delete(messageId));
	detailRequests.set(messageId, request);
	return request;
}
