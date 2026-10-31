import { z } from "zod";

import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Brave Search",
  category: "knowledge",
  description: {
    en: "Let your assistant find relevant web content and source URLs with Brave LLM Context.",
    nl: "Laat uw assistent relevante webinhoud en bronlinks ophalen met Brave LLM Context.",
  },
  auth: {
    type: "api_key",
    schema: z.strictObject({
      apiKey: z.string().trim().min(1).max(2_048),
    }),
  },
  config: z.strictObject({}),
  async verifyCredentials({ credentials, signal, response }) {
    // Key verification uses one search request.
    await response(
      await fetch(
        "https://api.search.brave.com/res/v1/web/search?q=Brave&count=1",
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": credentials.apiKey,
          },
          signal,
        },
      ),
    );
  },
  async response(response) {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z
        .object({
          error: z.object({ code: z.string() }),
        })
        .safeParse(payload);
      const providerCode = error.success ? error.data.error.code : undefined;
      const code =
        response.status === 401 ||
        response.status === 403 ||
        providerCode === "SUBSCRIPTION_TOKEN_INVALID"
          ? "provider_authentication_failed"
          : response.status === 429
            ? "provider_rate_limited"
            : "provider_error";
      throw new IntegrationError(
        code,
        `Brave Search request failed (${response.status})`,
      );
    }
    if (!z.record(z.string(), z.unknown()).safeParse(payload).success) {
      throw new IntegrationError(
        "invalid_provider_response",
        "Brave Search returned an invalid response",
      );
    }
    return payload;
  },
});
