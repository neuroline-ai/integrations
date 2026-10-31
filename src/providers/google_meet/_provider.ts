import { z } from "zod";
import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Google Meet",
  category: "communication",
  description: {
    en: "Create Google Meet links for online appointments with your assistant.",
    nl: "Laat uw assistent Google Meet-links aanmaken voor online afspraken.",
  },
  auth: {
    type: "oauth2",
    clientIdEnv: "AUTH_GOOGLE_ID",
    clientSecretEnv: "AUTH_GOOGLE_SECRET",
    schema: z.strictObject({
      accessToken: z.string().trim().min(1).max(16_384),
    }),
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/meetings.space.created"],
    authorizationParams: {
      access_type: "offline",
      prompt: "consent select_account",
    },
    toCredentials: (tokens) => ({ accessToken: tokens.accessToken }),
  },
  config: z.strictObject({}),
  async response(response) {
    if (!response.ok) {
      throw new IntegrationError(
        response.status === 401
          ? "provider_authentication_failed"
          : response.status === 403
            ? "provider_permission_denied"
            : response.status === 429
              ? "provider_rate_limited"
              : "provider_error",
        `Google Meet request failed (${response.status})`,
      );
    }
    return await response.json();
  },
});
