import { z } from "zod";

import { defineAction } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description: "Lists up to 20 upcoming bookings for a Cal.com event type.",
  input: z.strictObject({
    event_type_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Exact Cal.com event type ID."),
  }),
  async execute({ credentials, input, signal }) {
    const eventTypeId = input.event_type_id;
    const response = await fetch(
      `https://api.cal.com/v2/bookings?${new URLSearchParams({
        eventTypeId,
        status: "upcoming",
        sortStart: "asc",
        limit: "20",
      }).toString()}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "cal-api-version": "2026-05-01",
        },
        signal,
      },
    );
    const values = await provider.response(response);
    return (Array.isArray(values) ? (values as unknown[]) : [])
      .filter(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          ("uid" in value || "id" in value),
      )
      .slice(0, 20);
  },
});
