import { z } from "zod";
import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Creates a new Google Meet link. Does not create a calendar event. Never retry an uncertain creation without verification.",
  input: z.strictObject({}),
  async execute({ credentials, signal }) {
    try {
      const response = await fetch("https://meet.googleapis.com/v2/spaces", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal,
      });
      const space = z
        .object({
          name: z.string().regex(/^spaces\/[^/]+$/),
          meetingUri: z.url({
            protocol: /^https$/,
            hostname: /^meet\.google\.com$/,
          }),
        })
        .parse(await provider.response(response));
      return { id: space.name, url: space.meetingUri };
    } catch (error) {
      if (error instanceof IntegrationError && error.code !== "provider_error")
        throw error;
      throw new IntegrationError(
        "meeting_creation_uncertain",
        "Google Meet creation could not be confirmed. A meeting may have been created; do not retry without verification.",
      );
    }
  },
});
