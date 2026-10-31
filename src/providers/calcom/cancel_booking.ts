import { z } from "zod";

import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Cancels a selected Cal.com booking after explicit caller confirmation.",
  input: z.strictObject({
    booking_uid: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Exact Cal.com booking UID returned by list_bookings."),
    cancellation_reason: z
      .string()
      .trim()
      .max(500)
      .default("")
      .describe("Short reason, or an empty string when none was given."),
  }),
  async execute({ credentials, input, signal }) {
    const response = await fetch(
      `https://api.cal.com/v2/bookings/${encodeURIComponent(input.booking_uid)}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "cal-api-version": "2026-02-25",
          "content-type": "application/json",
        },
        body: JSON.stringify(
          input.cancellation_reason
            ? { cancellationReason: input.cancellation_reason }
            : {},
        ),
        signal,
      },
    );
    const result = await provider.response(response);
    const booking = Array.isArray(result) ? (result as unknown[])[0] : result;
    if (
      !booking ||
      typeof booking !== "object" ||
      (!("uid" in booking) && !("id" in booking))
    ) {
      throw new IntegrationError(
        "invalid_provider_response",
        "Cal.com returned an invalid booking",
      );
    }
    return booking;
  },
});
