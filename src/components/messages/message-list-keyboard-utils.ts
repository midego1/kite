/**
 * The row j (`step` 1) or k (`step` -1) moves to: from no focused row, j starts at the first row and k at the
 * last; at either end the focus stays where it is.
 */
export function adjacentRowIndex(count: number, current: number, step: 1 | -1): number {
	if (count === 0) return -1;
	if (current < 0) return step === 1 ? 0 : count - 1;
	return Math.min(count - 1, Math.max(0, current + step));
}
