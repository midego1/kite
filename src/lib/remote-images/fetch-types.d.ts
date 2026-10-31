export type RemoteImageFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Which destinations the proxy may fetch. */
export type RemoteImageUrlPolicy = {
	/** Origin of this install; the proxy never fetches it (or any other port on its host). */
	appOrigin: string;
	/** Dev/test only: allow http and any port on 127.0.0.1, for a local image server in the e2e suite. */
	allowLoopback?: boolean;
};

export type RemoteImageFetchOptions = RemoteImageUrlPolicy & {
	fetch?: RemoteImageFetch;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
};

export type RemoteImageResult = {
	body: Uint8Array<ArrayBuffer>;
	contentType: string;
};
