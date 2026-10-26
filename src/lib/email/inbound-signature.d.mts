export function signInbound(secret: string, raw: ArrayBuffer, from: string, to: string): Promise<string>;
export function signInboundHeaders(
	secret: string,
	raw: ArrayBuffer,
	from: string,
	to: string,
	headersJson: string,
): Promise<string>;
