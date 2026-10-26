import type { TooltipProps } from "./tooltip-types";

// "auto" sits below the trigger and flips above it when the viewport has no room (Radix collision handling).
export function tooltipSide(placement: TooltipProps["placement"] = "auto"): "bottom" | "right" {
	return placement === "right" ? "right" : "bottom";
}
