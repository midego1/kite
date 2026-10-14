import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { Refusal } from "./answer-utils";

/** A decision the user's request cannot have, answered with its status instead of failing the call. */
export class FinanceRefusal extends Error {
	constructor(
		readonly status: Refusal["status"],
		message: string,
	) {
		super(message);
	}
}

export const MIGRATION_PENDING_ERROR = "Apply the pending database update first";

/** Runs a query on the Money Watch tables; before migration 0063 it refuses with 409 instead of failing. */
export async function onFinanceTables<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new FinanceRefusal(409, MIGRATION_PENDING_ERROR);
		throw error;
	}
}

export function refusalOf(error: unknown): Refusal | null {
	return error instanceof FinanceRefusal ? { status: error.status, error: error.message } : null;
}
