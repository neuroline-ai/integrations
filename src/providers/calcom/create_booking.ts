import { z } from "zod";

import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Creates a booking for a Cal.com event type after the caller approves the details.",
  input: z
    .strictObject({
      event_type_id: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Exact Cal.com event type ID."),
      start: z.iso
        .datetime()
        .describe("Exact ISO 8601 start returned by list_slots."),
      attendee_name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Attendee's full name."),
      attendee_email: z
        .string()
        .trim()
        .max(320)
        .default("")
        .describe("Attendee email, or an empty string when phone is used."),
      attendee_phone: z
        .string()
        .trim()
        .max(50)
        .default("")
        .describe(
          "Attendee phone number, or an empty string when email is used.",
        ),
      time_zone: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .describe("Attendee's IANA time zone."),
    })
    .refine(
      ({ attendee_email, attendee_phone }) => attendee_email || attendee_phone,
      "An attendee email or phone number is required",
    ),
  async execute({ credentials, input, signal }) {
    const eventTypeId = input.event_type_id;
    const response = await fetch("https://api.cal.com/v2/bookings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "cal-api-version": "2026-02-25",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventTypeId: Number.isFinite(Number(eventTypeId))
          ? Number(eventTypeId)
          : eventTypeId,
        start: input.start,
        attendee: {
          name: input.attendee_name,
          ...(input.attendee_email ? { email: input.attendee_email } : {}),
          ...(input.attendee_phone
            ? { phoneNumber: input.attendee_phone }
            : {}),
          timeZone: input.time_zone,
        },
      }),
      signal,
    });
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
