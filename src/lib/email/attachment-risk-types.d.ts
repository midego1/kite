/** `danger`: runs code, carries macros or hides its type. `warning`: can hide other files or show a fake page. */
export type AttachmentRiskLevel = "ok" | "warning" | "danger";

export type AttachmentRisk = { level: AttachmentRiskLevel; reasons: string[] };
