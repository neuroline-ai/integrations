import { z } from "zod";
import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Google Calendar",
  category: "management",
  description: {
    en: "Find available times and book appointments directly in your Google Calendar.",
    nl: "Laat uw assistent beschikbare tijden zoeken en afspraken rechtstreeks in uw Google Agenda plannen.",
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
    scopes: [
      "calendar.calendarlist.readonly",
      "calendar.events.freebusy",
      "calendar.events",
    ].map((scope) => `https://www.googleapis.com/auth/${scope}`),
    authorizationParams: {
      access_type: "offline",
      prompt: "consent select_account",
    },
    toCredentials: (tokens) => ({ accessToken: tokens.accessToken }),
  },
  config: z.strictObject({
    location: z
      .discriminatedUnion("type", [
        z.strictObject({ type: z.literal("none") }),
        z.strictObject({
          type: z.literal("in_person"),
          address: z.string().trim().min(1).max(500),
        }),
        z.strictObject({
          type: z.literal("online"),
          provider: z.enum(["google_meet", "zoom"]).meta({ integration: true }),
        }),
      ])
      .default({ type: "none" }),
    calendar: z.strictObject({
      id: z.string().min(1).max(1024),
      title: z.string().min(1).max(1024),
      timeZone: z
        .string()
        .min(1)
        .max(100)
        .refine((timeZone) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone }).format();
            return true;
          } catch {
            return false;
          }
        }, "Choose a valid IANA time zone"),
    }),
  }),
  resources: {
    calendar: {
      async list({ credentials, signal, response }) {
        const calendars = [];
        let pageToken: string | undefined;
        let count = 0;
        const seen = new Set<string>();
        do {
          const params = new URLSearchParams({
            minAccessRole: "writer",
            maxResults: "250",
          });
          if (pageToken) params.set("pageToken", pageToken);
          const parsed = z
            .object({
              items: z
                .array(
                  z.object({
                    id: z.string().min(1).max(1024),
                    summary: z.string().min(1).max(1024),
                    timeZone: z
                      .string()
                      .min(1)
                      .max(100)
                      .refine((timeZone) => {
                        try {
                          new Intl.DateTimeFormat("en", { timeZone }).format();
                          return true;
                        } catch {
                          return false;
                        }
                      }, "Choose a valid IANA time zone"),
                    accessRole: z.string(),
                    deleted: z.boolean().optional(),
                  }),
                )
                .default([]),
              nextPageToken: z.string().min(1).max(4096).optional(),
            })
            .safeParse(
              await response(
                await fetch(
                  `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params.toString()}`,
                  {
                    headers: {
                      Authorization: `Bearer ${credentials.accessToken}`,
                    },
                    signal,
                  },
                ),
              ),
            );
          if (!parsed.success || (count += parsed.data.items.length) > 1000) {
            throw new IntegrationError(
              "invalid_provider_response",
              "Could not load the calendar list (maximum 1,000 calendars)",
            );
          }
          calendars.push(
            ...parsed.data.items
              .filter(
                (item) =>
                  !item.deleted &&
                  ["writer", "owner"].includes(item.accessRole),
              )
              .map((item) => ({
                id: item.id,
                title: item.summary,
                timeZone: item.timeZone,
              })),
          );
          pageToken = parsed.data.nextPageToken;
          if (pageToken && seen.has(pageToken))
            throw new IntegrationError(
              "invalid_provider_response",
              "Google Calendar returned repeated pages",
            );
          if (pageToken) seen.add(pageToken);
        } while (pageToken);
        return calendars.sort((a, b) => a.title.localeCompare(b.title));
      },
    },
  },
  async response(response) {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z
        .object({
          error: z.object({
            errors: z.array(z.object({ reason: z.string() })).optional(),
          }),
        })
        .safeParse(payload);
      const limited =
        response.status === 429 ||
        (error.success &&
          error.data.error.errors?.some(({ reason }) =>
            [
              "rateLimitExceeded",
              "userRateLimitExceeded",
              "quotaExceeded",
            ].includes(reason),
          ));
      const code = limited
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
        `Google Calendar request failed (${response.status})`,
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new IntegrationError(
        "invalid_provider_response",
        "Google Calendar returned an invalid response",
      );
    return payload;
  },
});
