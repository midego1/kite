/**
 * A connection Kite refuses to make or to continue: a private or local host, a port outside the mail ports, or a
 * server that cannot be reached over TLS. Retrying cannot fix it, so background jobs fail at once.
 */
export class MailServerRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MailServerRefusedError";
	}
}
