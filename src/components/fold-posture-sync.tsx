"use client";

import { useFoldPostureAttribute } from "@/components/use-fold-posture";

// Keeps <html data-fold-posture> in step with the device; it renders nothing.
export function FoldPostureSync() {
	useFoldPostureAttribute();
	return null;
}
