export type PublicBookingRouteContext = { params: Promise<{ eventId: string }> };
export type PublicBookingSubmission = { startsAt?: unknown; name?: unknown; email?: unknown; guestEmails?: unknown; notes?: unknown };
export type ValidBookingSubmission = { name: string; email: string; startsAt: string; guestEmails: string[]; notes: string };
