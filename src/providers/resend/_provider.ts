import { z } from "zod";
import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Resend",
  category: "communication",
  description: {
    en: "Send confirmations and requested information by email through Resend using your verified sender domain.",
    nl: "Laat uw assistent bevestigingen en gevraagde informatie e-mailen via Resend met uw geverifieerde afzenderdomein.",
  },
  auth: {
    type: "api_key",
    schema: z.strictObject({
      apiKey: z.string().trim().min(1).max(2_048),
    }),
  },
  config: z
    .strictObject({
      domain: z
        .strictObject({
          id: z.string().min(1).max(128),
          title: z.string().trim().toLowerCase().min(1).max(253),
        })
        .nullable()
        .default(null),
      from: z
        .string()
        .trim()
        .max(320)
        .pipe(z.email())
        .meta({ domainField: "domain" }),
    })
    .refine(
      ({ from, domain }) =>
        domain === null ||
        from.slice(from.lastIndexOf("@") + 1).toLowerCase() === domain.title,
      { message: "Use an address on the selected domain", path: ["from"] },
    ),
  resources: {
    domain: {
      async list({ credentials, signal, response }) {
        signal.throwIfAborted();
        // Without a limit, Resend returns all domains in one response.
        const result = await fetch("https://api.resend.com/domains", {
          redirect: "error",
          headers: { Authorization: `Bearer ${credentials.apiKey}` },
          signal,
        });
        if (
          result.status === 401 &&
          z.object({ name: z.literal("restricted_api_key") }).safeParse(
            await result
              .clone()
              .json()
              .catch(() => null),
          ).success
        )
          return null;
        const domains = z
          .object({
            has_more: z.literal(false).optional(),
            data: z
              .array(
                z.object({
                  id: z.string().min(1).max(128),
                  name: z.string().trim().toLowerCase().min(1).max(253),
                  status: z.string(),
                  capabilities: z.object({
                    sending: z.enum(["enabled", "disabled"]),
                  }),
                }),
              )
              .max(1000),
          })
          .parse(await response(result));
        return domains.data
          .filter(
            (domain) =>
              domain.status === "verified" &&
              domain.capabilities.sending === "enabled",
          )
          .map((domain) => ({ id: domain.id, title: domain.name }))
          .sort((left, right) => left.title.localeCompare(right.title));
      },
    },
  },
  async response(response) {
    if (!response.ok) {
      throw new IntegrationError(
        response.status === 401
          ? "provider_authentication_failed"
          : response.status === 403
            ? "provider_permission_denied"
            : response.status === 429
              ? "provider_rate_limited"
              : response.status >= 400 &&
                  response.status < 500 &&
                  response.status !== 408 &&
                  response.status !== 409
                ? "provider_request_rejected"
                : "provider_error",
        `Resend request failed (${response.status})`,
      );
    }
    return await response.json();
  },
});
