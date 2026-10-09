import type { ConfirmOptions, PendingConfirmation } from "./confirm-dialog-types";

type Listener = (pending: PendingConfirmation | null) => void;

let nextId = 1;
const queue: PendingConfirmation[] = [];
const listeners = new Set<Listener>();

function publish() {
	for (const listener of listeners) listener(queue[0] ?? null);
}

/**
 * Asks the user to confirm through the shared dialog mounted by
 * ConfirmDialogHost. Resolves to false when cancelled or dismissed. Requests
 * made while one is open wait their turn.
 */
export function requestConfirmation(options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		queue.push({ ...options, id: nextId++, resolve });
		if (queue.length === 1) publish();
	});
}

export function settleConfirmation(id: number, confirmed: boolean) {
	const index = queue.findIndex((pending) => pending.id === id);
	if (index === -1) return;
	const [pending] = queue.splice(index, 1);
	pending.resolve(confirmed);
	publish();
}

export function subscribeToConfirmations(listener: Listener): () => void {
	listeners.add(listener);
	listener(queue[0] ?? null);
	return () => {
		listeners.delete(listener);
	};
}

export function matchesTypedConfirmation(expected: string | undefined, typed: string): boolean {
	if (!expected) return true;
	return typed.trim().toLowerCase() === expected.trim().toLowerCase();
}
