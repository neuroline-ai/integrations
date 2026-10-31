import { z } from "zod";
import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Lists free slots of the requested duration within the supplied range on the configured Outlook calendar. Offer only returned slots in the returned time zone.",
  input: z
    .strictObject({
      duration_minutes: z
        .number()
        .int()
        .positive()
        .describe(
          "Appointment duration in minutes. Use the same duration when creating the booking.",
        ),
      start: z.iso
        .datetime({ offset: true })
        .describe(
          "Start of the search range as an ISO 8601 date-time with an offset.",
        ),
      end: z.iso
        .datetime({ offset: true })
        .describe("End of the search range, at most 31 days after start."),
    })
    .refine(
      ({ start, end }) =>
        Date.parse(end) > Date.parse(start) &&
        Date.parse(end) - Date.parse(start) <= 31 * 86_400_000,
      "Search at most 31 days at a time",
    ),
  async execute({ credentials, config, input, signal }) {
    const start = Date.parse(input.start);
    const end = Date.parse(input.end);
    const headers = {
      Authorization: `Bearer ${credentials.accessToken}`,
      "content-type": "application/json",
      Prefer: 'outlook.timezone="UTC"',
    };
    // Graph returns UTC timestamps without an offset.
    const graphDateTime = z
      .object({
        dateTime: z.iso.datetime({ local: true }),
        timeZone: z.literal("UTC"),
      })
      .transform(({ dateTime }) =>
        dateTime.endsWith("Z") ? dateTime : `${dateTime}Z`,
      );
    const availabilityParams = new URLSearchParams({
      startDateTime: input.start,
      endDateTime: input.end,
      $select: "start,end,showAs,isCancelled",
      $top: "1000",
    });
    const events: unknown[] = [];
    let next: string | undefined =
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(config.calendar.id)}/calendarView?${availabilityParams.toString()}`;
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
          await provider.response(
            await fetch(next, {
              headers,
              signal,
              redirect: "error",
            }),
          ),
        );
      if (!page.success || events.length + page.data.value.length > 10000)
        throw new IntegrationError(
          "invalid_provider_response",
          "Could not load all Outlook Calendar results",
        );
      events.push(...page.data.value);
      next = page.data["@odata.nextLink"];
    }
    const parsed = z
      .array(
        z.object({
          start: graphDateTime,
          end: graphDateTime,
          isCancelled: z.boolean(),
          showAs: z.enum([
            "free",
            "tentative",
            "busy",
            "oof",
            "workingElsewhere",
            "unknown",
          ]),
        }),
      )
      .safeParse(events);
    if (
      !parsed.success ||
      parsed.data.some(
        (event) => Date.parse(event.end) <= Date.parse(event.start),
      )
    )
      throw new IntegrationError(
        "availability_unavailable",
        "Calendar availability could not be verified; do not offer or book this time",
      );
    const busy = parsed.data
      .filter((event) => !event.isCancelled && event.showAs !== "free")
      .map(({ start, end }) => ({
        start: Date.parse(start),
        end: Date.parse(end),
      }))
      .sort((a, b) => a.start - b.start);
    const duration = input.duration_minutes * 60_000;
    const slots: { start: string; end: string }[] = [];
    for (let time = start; time + duration <= end && slots.length < 20; ) {
      const conflict = busy.find(
        (period) => time < period.end && time + duration > period.start,
      );
      if (conflict) {
        time = conflict.end;
        continue;
      }
      slots.push({
        start: new Date(time).toISOString(),
        end: new Date(time + duration).toISOString(),
      });
      time += duration;
    }
    return { timeZone: config.timeZone, slots };
  },
});
