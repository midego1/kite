/** A refused executor or undo call; routes answer with `status`. */
export class AgentActionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409,
	) {
		super(message);
		this.name = "AgentActionError";
	}
}
