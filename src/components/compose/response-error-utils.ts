/** The server's own reason in a failed JSON response, else `fallback`. */
export async function responseError(response: Response, fallback: string): Promise<string> {
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	return body.error ?? fallback;
}
