import { z } from "zod";

/**
 * An instruction field of at most `max` characters, counted as code points like the settings' counter and the
 * prompt cleaning (`Array.from`), so an emoji counts once everywhere. A code point is at most two UTF-16 units,
 * which bounds the work before the count.
 */
export function instructionText(max: number) {
	return z
		.string()
		.max(max * 2)
		.refine((value) => Array.from(value).length <= max);
}
