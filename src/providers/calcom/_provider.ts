import { z } from "zod";

import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Cal.com",
  category: "management",
  description: {
    en: "Check availability and create, reschedule, or cancel bookings with Cal.com.",
    nl: "Laat uw assistent de beschikbaarheid controleren en afspraken plannen, verplaatsen of annuleren via Cal.com.",
  },
  auth: {
    type: "api_key",
    schema: z.strictObject({
      apiKey: z.string().trim().min(1).max(2_048),
    }),
  },
  config: z.strictObject({}),
  async verifyCredentials({ credentials, signal, response }) {
    await response(
      await fetch("https://api.cal.com/v2/me", {
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
        },
        signal,
      }),
    );
  },
  async response(response) {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        response.status === 401 || response.status === 403
          ? "provider_authentication_failed"
          : response.status === 404
            ? "provider_resource_not_found"
            : response.status === 409 || response.status === 422
              ? "booking_conflict"
              : response.status === 429
                ? "provider_rate_limited"
                : "provider_error";
      throw new IntegrationError(
        code,
        code === "booking_conflict"
          ? "Cal.com could not accept that booking; request fresh availability"
          : `Cal.com request failed (${response.status})`,
      );
    }
    if (payload && typeof payload === "object" && "data" in payload) {
      return (payload as { data?: unknown }).data;
    }
    return payload;
  },
});
