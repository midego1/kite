export function parseBookingHostIds(value: string, ownerId: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			Array.isArray(parsed) &&
			parsed.length &&
			parsed.every((id) => typeof id === "string" && id.length > 0) &&
			new Set(parsed).size === parsed.length
		)
			return [ownerId, ...parsed.filter((id) => id !== ownerId)];
	} catch {
		/* Older booking events have only the owner. */
	}
	return [ownerId];
}
