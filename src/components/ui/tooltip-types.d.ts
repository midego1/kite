import type { ReactNode } from "react";

export type TooltipProps = {
	label: null | string;
	children: ReactNode;
	className?: string;
	placement?: "auto" | "right";
};
