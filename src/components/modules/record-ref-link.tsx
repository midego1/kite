import Link from "next/link";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import type { RecordRefTarget } from "@/lib/modules/record-ref-types";

type RecordRefLinkProps = {
	target: RecordRefTarget;
	/** Classes for the anchor; plain text uses `textClassName` so it never looks clickable. */
	className?: string;
	textClassName?: string;
} & { [attribute: `data-${string}`]: string | undefined };

/** A resolved record ref: a link when it has a same-origin href, otherwise plain text with no anchor. */
export function RecordRefLink({ target, className, textClassName, ...attributes }: RecordRefLinkProps) {
	if (isSameOriginPath(target.href))
		return (
			<Link href={target.href} className={className} {...attributes}>
				{target.label}
			</Link>
		);
	return (
		<span className={textClassName} {...attributes}>
			{target.label}
		</span>
	);
}
