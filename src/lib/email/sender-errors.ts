/** A refusal whose text is meant for the person sending (as opposed to a failure of the database or the runtime). */
export class SenderRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderRefusedError";
	}
}
