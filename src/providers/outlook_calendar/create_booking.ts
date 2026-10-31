import { z } from "zod";
import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Creates one Outlook appointment after the caller confirms the time and contact details. Use the exact start returned by list_slots. Email is optional. When SMS is configured, a confirmation is sent to attendee_phone. Report SMS failure separately from booking success. Never retry an uncertain booking without verification.",
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
  async execute({ credentials, config, input, signal, sendSms }) {
    const start = Date.parse(input.start);
    const end = start + input.duration_minutes * 60_000;
    const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(config.calendar.id)}/events`;
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
    const location =
      config.location.type === "in_person"
        ? config.location.address
        : undefined;
    const sendConfirmation = input.attendee_phone ? sendSms : undefined;
    const result = (value: unknown) => {
      const parsed = z
        .object({
          id: z.string().min(1),
          subject: z.literal(input.title),
          isCancelled: z.literal(false),
          start: graphDateTime,
          end: graphDateTime,
          location: z.object({ displayName: z.string() }).optional(),
        })
        .safeParse(value);
      if (
        !parsed.success ||
        Date.parse(parsed.data.start) !== start ||
        Date.parse(parsed.data.end) !== end ||
        (location && parsed.data.location?.displayName !== location)
      )
        throw new IntegrationError(
          "booking_uncertain",
          "This booking could not be confirmed or has changed; verify the appointment before proceeding",
        );
      return {
        eventId: parsed.data.id,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        timeZone: config.timeZone,
        ...(location ? { location } : {}),
      };
    };
    const availabilityParams = new URLSearchParams({
      startDateTime: new Date(start).toISOString(),
      endDateTime: new Date(end).toISOString(),
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
    if (busy.some((period) => start < period.end && end > period.start))
      throw new IntegrationError(
        "booking_conflict",
        "This time is no longer available; request fresh availability",
      );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        signal,
        redirect: "error",
        body: JSON.stringify({
          subject: input.title,
          body: {
            contentType: "text",
            content: [
              input.description,
              `Name: ${input.attendee_name}`,
              ...(input.attendee_phone
                ? [`Phone: ${input.attendee_phone}`]
                : []),
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          start: { dateTime: new Date(start).toISOString(), timeZone: "UTC" },
          end: { dateTime: new Date(end).toISOString(), timeZone: "UTC" },
          showAs: "busy",
          ...(location ? { location: { displayName: location } } : {}),
          ...(input.attendee_email
            ? {
                attendees: [
                  {
                    emailAddress: {
                      address: input.attendee_email,
                      name: input.attendee_name,
                    },
                    type: "required",
                  },
                ],
              }
            : {}),
        }),
      });
    } catch {
      throw new IntegrationError(
        "booking_uncertain",
        "The Outlook booking could not be confirmed; verify the calendar before retrying.",
      );
    }
    if (response.status >= 500)
      throw new IntegrationError(
        "booking_uncertain",
        "The Outlook booking could not be confirmed; verify the calendar before retrying.",
      );
    const payload = await provider
      .response(response)
      .catch((error: unknown) => {
        if (response.ok)
          throw new IntegrationError(
            "booking_uncertain",
            "The Outlook booking could not be confirmed; verify the calendar before retrying.",
          );
        throw error;
      });
    const booking = result(payload);
    if (!sendConfirmation) return booking;
    const when = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: config.timeZone,
    }).format(start);
    try {
      return {
        ...booking,
        sms: await sendConfirmation({
          to: input.attendee_phone,
          message: [
            `Appointment confirmed: ${input.title.slice(0, 120)}`,
            `${when} (${config.timeZone})`,
            location,
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      };
    } catch {
      return { ...booking, sms: { ok: false, error: "sms_delivery_failed" } };
    }
  },
});
