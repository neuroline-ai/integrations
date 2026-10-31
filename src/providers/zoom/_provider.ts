import { z } from "zod";
import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Zoom",
  category: "communication",
  description: {
    en: "Create Zoom meetings for online appointments with your assistant.",
    nl: "Laat uw assistent Zoom-vergaderingen aanmaken voor online afspraken.",
  },
  auth: {
    type: "oauth2",
    clientIdEnv: "AUTH_ZOOM_ID",
    clientSecretEnv: "AUTH_ZOOM_SECRET",
    schema: z.strictObject({
      accessToken: z.string().trim().min(1).max(16_384),
    }),
    authorizationUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    tokenEndpointAuthMethod: "client_secret_basic",
    scopes: ["meeting:write:meeting"],
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
              : response.status >= 400 && response.status < 500
                ? "provider_request_rejected"
                : "provider_error",
        `Zoom request failed (${response.status})`,
      );
    }
    return await response.json();
  },
});
