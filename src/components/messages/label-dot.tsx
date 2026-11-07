import { cn } from "@/lib/utils";

/**
 * A small rounded square in a chosen colour, the mark of a mailbox. It is a square on purpose: the round blue dot on an
 * avatar means "unread", and a mailbox's mark must never be taken for it. Decorative; the name travels with whatever
 * holds it.
 */
export function LabelDot({ color, className }: { color: string; className?: string }) {
	return (
		<span
			aria-hidden
			data-label-dot={color}
			className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-neutral-400/50", className)}
			style={{ backgroundColor: color }}
		/>
	);
}
