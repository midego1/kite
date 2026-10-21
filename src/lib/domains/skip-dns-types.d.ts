/**
 * Why a skipped domain's Cloudflare zone could not be attached: another account owns
 * the zone, no zone on this account holds the hostname, or Cloudflare could not be asked.
 */
export type ZoneAdoptionCode = "ZONE_CLAIMED" | "ZONE_NOT_FOUND" | "ZONE_LOOKUP_FAILED";
