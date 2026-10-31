import { z } from "zod";
import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Lists free slots of the requested duration within the supplied range on the configured Google calendar. Offer only returned slots in the returned time zone.",
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
    const result = await provider.response(
      await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          timeMin: new Date(start).toISOString(),
          timeMax: new Date(end).toISOString(),
          timeZone: config.calendar.timeZone,
          items: [{ id: config.calendar.id }],
        }),
        signal,
      }),
    );
    const parsed = z
      .object({
        calendars: z.record(
          z.string(),
          z.object({
            busy: z
              .array(
                z.object({
                  start: z.iso.datetime({ offset: true }),
                  end: z.iso.datetime({ offset: true }),
                }),
              )
              .optional(),
            errors: z.array(z.unknown()).optional(),
          }),
        ),
      })
      .safeParse(result);
    const availability = parsed.success
      ? parsed.data.calendars[config.calendar.id]
      : undefined;
    if (
      !availability?.busy ||
      availability.errors?.length ||
      availability.busy.some(
        (item) => Date.parse(item.end) <= Date.parse(item.start),
      )
    ) {
      throw new IntegrationError(
        "availability_unavailable",
        "Calendar availability could not be verified; do not offer or book this time",
      );
    }
    const busy = availability.busy
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
    return {
      timeZone: config.calendar.timeZone,
      slots,
    };
  },
});
