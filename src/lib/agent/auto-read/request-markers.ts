// Every automatic model request carries exactly one of these in its prompt, so logs and the e2e fake
// model (e2e/support/fake-model.ts) can tell the request types apart. Keep them free of `@/` imports:
// the fake model imports this file directly. None is a substring of another.
export const TRIAGE_SYSTEM_MARKER = "[kite:auto-read:triage]";
export const REPAIR_MARKER = "[kite:auto-read:repair]";
export const DRAFT_SYSTEM_MARKER = "[kite:auto-read:draft]";
export const COMPOSE_SYSTEM_MARKER = "[kite:composer]";
export const SUMMARY_SYSTEM_MARKER = "[kite:summary]";
export const SUMMARY_TRANSLATION_MARKER = "[kite:summary-translation]";
export const LINE_SUMMARY_SYSTEM_MARKER = "[kite:list-line]";
