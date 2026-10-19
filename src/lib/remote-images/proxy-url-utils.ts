const REMOTE_IMAGE_PROXY_PATH = "/api/remote-images";

/**
 * The same-origin proxy address the reader loads a consented remote image from. The message
 * id lets the server check that the image really appears in a message the reader can open.
 */
export function remoteImageProxyUrl(messageId: string, imageUrl: string): string {
	return `${REMOTE_IMAGE_PROXY_PATH}?${new URLSearchParams({ message: messageId, url: imageUrl })}`;
}
