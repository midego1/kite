/** A refused executor or undo call; routes answer with `status`. */
export class AgentActionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409,
		/** Set when the refusal has a code a client can act on, such as `module_disabled`. */
		readonly code?: string,
	) {
		super(message);
		this.name = "AgentActionError";
	}
}
