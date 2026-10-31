import { z } from "zod";
import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Creates one appointment with the configured location after the caller confirms the time and contact details. Use the exact start returned by list_slots. Email is optional. When SMS is configured, a confirmation is sent to attendee_phone. Report SMS failure separately from booking success. Never retry an uncertain booking without verification.",
  input: z
    .strictObject({
      title: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .describe("Event title shown in the calendar."),
      duration_minutes: z
        .number()
        .int()
        .positive()
        .describe(
          "Appointment duration in minutes. Use the same duration as list_slots.",
        ),
      description: z
        .string()
        .trim()
        .max(10000)
        .default("")
        .describe("Event description, or an empty string when none is needed."),
      start: z.iso
        .datetime({ offset: true })
        .describe("Exact start returned by list_slots."),
      attendee_name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Confirmed full name of the caller."),
      attendee_email: z
        .string()
        .trim()
        .max(320)
        .refine(
          (value) => value === "" || z.email().safeParse(value).success,
          "Enter a valid email",
        )
        .default("")
        .describe(
          "Confirmed email for a calendar invitation, or an empty string for a phone-only booking.",
        ),
      attendee_phone: z
        .string()
        .trim()
        .max(16)
        .refine(
          (value) => value === "" || /^\+[1-9]\d{6,14}$/u.test(value),
          "Enter a valid E.164 phone number",
        )
        .default("")
        .describe(
          "Confirmed phone in E.164 format, or an empty string when email is used.",
        ),
    })
    .refine(
      ({ attendee_email, attendee_phone }) => attendee_email || attendee_phone,
      "A confirmed email or phone is required",
    )
    .refine(
      ({ start, duration_minutes }) =>
        Number.isFinite(
          new Date(Date.parse(start) + duration_minutes * 60_000).getTime(),
        ),
      "Duration exceeds the supported date range",
    ),
  async execute({ credentials, config, input, signal, execute, sendSms }) {
    const sendConfirmation = input.attendee_phone ? sendSms : undefined;
    const start = Date.parse(input.start);
    const end = start + input.duration_minutes * 60_000;
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar.id)}/events`;
    const headers = {
      Authorization: `Bearer ${credentials.accessToken}`,
      "content-type": "application/json",
    };
    const result = (value: unknown) => {
      const parsed = z
        .object({
          id: z.string().min(1),
          status: z.string(),
          location: z.string().optional(),
          start: z.object({ dateTime: z.iso.datetime({ offset: true }) }),
          end: z.object({ dateTime: z.iso.datetime({ offset: true }) }),
        })
        .safeParse(value);
      if (
        !parsed.success ||
        parsed.data.status === "cancelled" ||
        Date.parse(parsed.data.start.dateTime) !== start ||
        Date.parse(parsed.data.end.dateTime) !== end ||
        (config.location.type === "in_person" &&
          parsed.data.location !== config.location.address) ||
        (config.location.type === "online" &&
          !z.url({ protocol: /^https$/ }).safeParse(parsed.data.location)
            .success)
      )
        throw new IntegrationError(
          "booking_uncertain",
          "The calendar booking could not be confirmed; verify the calendar before retrying.",
        );
      return {
        eventId: parsed.data.id,
        start: parsed.data.start.dateTime,
        end: parsed.data.end.dateTime,
        timeZone: config.calendar.timeZone,
        ...(parsed.data.location ? { location: parsed.data.location } : {}),
      };
    };
    if (config.location.type === "online" && !execute)
      throw new IntegrationError(
        "integration_unavailable",
        "Connect the configured meeting provider before booking",
      );
    const availabilityResponse = await provider.response(
      await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers,
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
      .safeParse(availabilityResponse);
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
    if (
      availability.busy.some(
        (period) =>
          start < Date.parse(period.end) && end > Date.parse(period.start),
      )
    )
      throw new IntegrationError(
        "booking_conflict",
        "This time is no longer available; request fresh availability",
      );
    const meeting =
      config.location.type === "online"
        ? z
            .object({
              id: z.string().min(1),
              url: z.url({ protocol: /^https$/ }),
            })
            .parse(
              await execute!(
                `${config.location.provider}.create_meeting`,
                config.location.provider === "google_meet"
                  ? {}
                  : {
                      title: input.title,
                      start: input.start,
                      duration_minutes: input.duration_minutes,
                    },
              ),
            )
        : undefined;
    const location =
      config.location.type === "in_person"
        ? config.location.address
        : meeting?.url;
    let response: Response | undefined;
    try {
      response = await fetch(
        `${url}?${new URLSearchParams({ sendUpdates: input.attendee_email ? "all" : "none" }).toString()}`,
        {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            summary: input.title,
            ...(location ? { location } : {}),
            description: [
              input.description,
              ...(input.attendee_phone
                ? [`Phone: ${input.attendee_phone}`]
                : []),
            ]
              .filter(Boolean)
              .join("\n\n"),
            start: {
              dateTime: new Date(start).toISOString(),
              timeZone: config.calendar.timeZone,
            },
            end: {
              dateTime: new Date(end).toISOString(),
              timeZone: config.calendar.timeZone,
            },
            transparency: "opaque",
            ...(input.attendee_email
              ? {
                  attendees: [
                    {
                      email: input.attendee_email,
                      displayName: input.attendee_name,
                    },
                  ],
                }
              : {}),
          }),
        },
      );
      const booking = result(await provider.response(response));
      if (!sendConfirmation) return booking;
      const when = new Intl.DateTimeFormat("en-GB", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: config.calendar.timeZone,
      }).format(start);
      try {
        return {
          ...booking,
          sms: await sendConfirmation({
            to: input.attendee_phone,
            message: [
              `Appointment confirmed: ${input.title.slice(0, 120)}`,
              `${when} (${config.calendar.timeZone})`,
              booking.location,
            ]
              .filter(Boolean)
              .join("\n"),
          }),
        };
      } catch {
        return { ...booking, sms: { ok: false, error: "sms_delivery_failed" } };
      }
    } catch (error) {
      if (
        error instanceof IntegrationError &&
        response &&
        response.status >= 400 &&
        response.status < 500
      ) {
        if (!meeting) throw error;
        throw new IntegrationError(
          error.code,
          `${error.message}. A meeting link was created; verify it before retrying.`,
        );
      }
      throw new IntegrationError(
        "booking_uncertain",
        meeting
          ? "The calendar booking could not be confirmed. A meeting link was created; verify the calendar before retrying."
          : "The calendar booking could not be confirmed; verify the calendar before retrying.",
      );
    }
  },
});
