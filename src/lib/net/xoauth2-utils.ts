/**
 * The SASL XOAUTH2 initial response (spec §15.4) that IMAP `AUTHENTICATE XOAUTH2` and SMTP `AUTH XOAUTH2` send:
 * base64 of `user=<address>^Aauth=Bearer <token>^A^A`, UTF-8 encoded. A control character in either value would shift
 * the fields or end the command line, so it is refused; the error never contains either value.
 */
export function xoauth2Token(user: string, accessToken: string): string {
	if (!user || !accessToken) throw new Error("XOAUTH2 needs a user name and an access token");
	if (/[\0-\x1f\x7f]/.test(user) || /[\0-\x1f\x7f\s]/.test(accessToken))
		throw new Error("XOAUTH2 user names and access tokens cannot contain control characters");
	let binary = "";
	for (const byte of new TextEncoder().encode(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`))
		binary += String.fromCharCode(byte);
	return btoa(binary);
}
