import { z } from "zod";
import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Outlook Calendar",
  category: "management",
  description: {
    en: "Find free times and book appointments in your Microsoft Outlook calendar.",
    nl: "Laat uw assistent vrije tijden zoeken en afspraken in uw Microsoft Outlook-agenda plannen.",
  },
  auth: {
    type: "oauth2",
    clientIdEnv: "AUTH_MICROSOFT_ID",
    clientSecretEnv: "AUTH_MICROSOFT_SECRET",
    schema: z.strictObject({
      accessToken: z.string().trim().min(1).max(16_384),
    }),
    authorizationUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Calendars.ReadWrite", "offline_access"],
    authorizationParams: { prompt: "select_account", response_mode: "query" },
    toCredentials: (tokens) => ({ accessToken: tokens.accessToken }),
  },
  config: z.strictObject({
    calendar: z.strictObject({
      id: z.string().min(1).max(1024),
      title: z.string().min(1).max(1024),
    }),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((timeZone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone }).format();
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid IANA time zone, such as Europe/Amsterdam"),
    location: z
      .discriminatedUnion("type", [
        z.strictObject({ type: z.literal("none") }),
        z.strictObject({
          type: z.literal("in_person"),
          address: z.string().trim().min(1).max(500),
        }),
      ])
      .default({ type: "none" }),
  }),
  resources: {
    calendar: {
      async list({ credentials, signal, response }) {
        const calendars: unknown[] = [];
        let next: string | undefined =
          `https://graph.microsoft.com/v1.0/me/calendars?${new URLSearchParams({ $select: "id,name,canEdit", $top: "100" }).toString()}`;
        const seen = new Set<string>();
        while (next) {
          const target = new URL(next);
          if (
            target.origin !== "https://graph.microsoft.com" ||
            !target.pathname.startsWith("/v1.0/") ||
            target.username ||
            target.password ||
            seen.has(next) ||
            seen.size >= 100
          )
            throw new IntegrationError(
              "invalid_provider_response",
              "Outlook Calendar returned invalid pagination",
            );
          seen.add(next);
          const page = z
            .object({
              value: z.array(z.unknown()),
              "@odata.nextLink": z.url().optional(),
            })
            .safeParse(
              await response(
                await fetch(next, {
                  headers: {
                    Authorization: `Bearer ${credentials.accessToken}`,
                  },
                  signal,
                  redirect: "error",
                }),
              ),
            );
          if (!page.success || calendars.length + page.data.value.length > 1000)
            throw new IntegrationError(
              "invalid_provider_response",
              "Could not load all Outlook Calendar results",
            );
          calendars.push(...page.data.value);
          next = page.data["@odata.nextLink"];
        }
        const parsed = z
          .array(
            z.object({
              id: z.string().min(1).max(1024),
              name: z.string().min(1).max(1024),
              canEdit: z.boolean(),
            }),
          )
          .safeParse(calendars);
        if (!parsed.success)
          throw new IntegrationError(
            "invalid_provider_response",
            "Could not load the Outlook calendar list",
          );
        return parsed.data
          .filter((calendar) => calendar.canEdit)
          .map(({ id, name }) => ({ id, title: name }))
          .sort((a, b) => a.title.localeCompare(b.title));
      },
    },
  },
  async response(response) {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        response.status === 429
          ? "provider_rate_limited"
          : response.status === 401
            ? "provider_authentication_failed"
            : response.status === 403
              ? "provider_permission_denied"
              : response.status === 404
                ? "provider_resource_not_found"
                : response.status === 409
                  ? "provider_duplicate"
                  : "provider_error";
      throw new IntegrationError(
        code,
        `Outlook Calendar request failed (${response.status})`,
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new IntegrationError(
        "invalid_provider_response",
        "Outlook Calendar returned an invalid response",
      );
    return payload;
  },
});
