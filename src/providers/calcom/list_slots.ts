import { z } from "zod";

import { defineAction } from "../../core.ts";
import provider from "./_provider.ts";

type CalcomSlot = { start: string; end?: string };

export default defineAction(provider, {
  description: "Lists available times for a Cal.com event type.",
  input: z
    .strictObject({
      event_type_id: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Exact Cal.com event type ID."),
      start: z.iso.datetime().describe("Range start as an ISO 8601 date-time."),
      end: z.iso
        .datetime()
        .describe(
          "Range end as an ISO 8601 date-time, no more than 31 days after start.",
        ),
      time_zone: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .describe("IANA time zone for the returned slots."),
    })
    .refine(({ start, end }) => {
      const duration = Date.parse(end) - Date.parse(start);
      return duration > 0 && duration <= 31 * 24 * 60 * 60 * 1_000;
    }, "Slot range must be between one instant and 31 days"),
  async execute({ credentials, input, signal }) {
    const eventTypeId = input.event_type_id;
    const response = await fetch(
      `https://api.cal.com/v2/slots?${new URLSearchParams({
        eventTypeId,
        start: input.start,
        end: input.end,
        timeZone: input.time_zone,
        format: "range",
      }).toString()}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "cal-api-version": "2024-09-04",
        },
        signal,
      },
    );
    const value = await provider.response(response);
    const groups =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const candidates = groups
      ? Object.values(groups).flatMap((value) =>
          Array.isArray(value) ? (value as unknown[]) : [],
        )
      : [];
    const slots = candidates.flatMap((value): CalcomSlot[] => {
      if (typeof value === "string") return [{ start: value }];
      const item =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const nestedStart =
        item?.start !== null &&
        typeof item?.start === "object" &&
        !Array.isArray(item.start)
          ? (item.start as Record<string, unknown>)
          : null;
      const nestedEnd =
        item?.end !== null &&
        typeof item?.end === "object" &&
        !Array.isArray(item.end)
          ? (item.end as Record<string, unknown>)
          : null;
      const start =
        typeof item?.start === "string" && item.start.trim()
          ? item.start.trim()
          : typeof nestedStart?.time === "string" && nestedStart.time.trim()
            ? nestedStart.time.trim()
            : undefined;
      if (!start) return [];
      const end =
        typeof item?.end === "string" && item.end.trim()
          ? item.end.trim()
          : typeof nestedEnd?.time === "string" && nestedEnd.time.trim()
            ? nestedEnd.time.trim()
            : undefined;
      return [{ start, ...(end ? { end } : {}) }];
    });
    return {
      eventTypeId,
      slots: [
        ...new Map(
          slots.map(
            (slot) => [`${slot.start}|${slot.end ?? ""}`, slot] as const,
          ),
        ).values(),
      ]
        .sort((left, right) => left.start.localeCompare(right.start))
        .slice(0, 20),
    };
  },
});
