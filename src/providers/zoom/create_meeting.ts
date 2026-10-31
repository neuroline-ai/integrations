import { z } from "zod";
import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Creates a scheduled Zoom meeting after the caller confirms the details and returns its attendee join link. Does not check availability, create a calendar event, or send invitations. Never retry an uncertain creation without verification.",
  input: z.strictObject({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Meeting title, up to 200 characters."),
    start: z.iso
      .datetime({ offset: true })
      .refine(
        (value) => Date.parse(value) > Date.now(),
        "Choose a future meeting time",
      )
      .describe(
        "Confirmed future start as an ISO 8601 date-time with a time zone offset.",
      ),
    duration_minutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .describe("Meeting duration in minutes, from 1 to 1440."),
  }),
  async execute({ credentials, input, signal }) {
    try {
      const response = await fetch("https://api.zoom.us/v2/users/me/meetings", {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: 2,
          topic: input.title,
          start_time: new Date(input.start).toISOString(),
          duration: input.duration_minutes,
          timezone: "UTC",
          settings: { use_pmi: false },
        }),
        signal,
      });
      const meeting = z
        .object({
          id: z.number().int().positive(),
          join_url: z.url({
            protocol: /^https$/,
            hostname: /(^|\.)zoom\.(us|com)$/u,
          }),
        })
        .parse(await provider.response(response));
      return { id: String(meeting.id), url: meeting.join_url };
    } catch (error) {
      if (error instanceof IntegrationError && error.code !== "provider_error")
        throw error;
      throw new IntegrationError(
        "meeting_creation_uncertain",
        "Zoom meeting creation could not be confirmed. A meeting may have been created; do not retry without verification.",
      );
    }
  },
});
