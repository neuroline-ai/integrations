import { afterEach, expect, test, vi } from "vitest";
import {
  configureIntegration,
  execute,
  previewIntegration,
} from "@neuroline/integrations";
import provider from "./_provider.ts";

const credentials = { accessToken: "secret" };
const calendar = { id: "calendar/one+=", title: "Work" };
const config = { calendar, timeZone: "Europe/Amsterdam" };
const context = {
  credentials,
  config,
  signal: new AbortController().signal,
};
const range = {
  start: "2026-10-27T09:00:00+01:00",
  end: "2026-10-27T12:00:00+01:00",
  duration_minutes: 30,
};
const appointment = {
  title: "Consultation",
  start: range.start,
  duration_minutes: 30,
  attendee_name: "Alex",
  attendee_email: "alex@example.com",
};
const utc = (dateTime: string) => ({ dateTime, timeZone: "UTC" });
const event = (start: string, end: string, extra = {}) => ({
  start: utc(start),
  end: utc(end),
  isCancelled: false,
  showAs: "busy",
  ...extra,
});
const respond = (...payloads: unknown[]) => {
  const request =
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  for (const payload of payloads)
    request.mockResolvedValueOnce(Response.json(payload));
  vi.stubGlobal("fetch", request);
  return request;
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("setup paginates writable calendars and replaces submitted resource metadata", async () => {
  const request = respond(
    {
      value: [{ id: "readonly", name: "Read only", canEdit: false }],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/me/calendars?$skip=1",
    },
    { value: [{ id: calendar.id, name: calendar.title, canEdit: true }] },
  );
  expect(await previewIntegration("outlook_calendar", { credentials })).toEqual(
    { calendar: [calendar] },
  );
  expect(request.mock.calls[1]?.[0]).toContain("$skip=1");
  request.mockImplementation(() =>
    Promise.resolve(
      Response.json({
        value: [{ id: calendar.id, name: calendar.title, canEdit: true }],
      }),
    ),
  );
  expect(
    (
      await configureIntegration("outlook_calendar", {
        credentials,
        config: { ...config, calendar: { ...calendar, title: "Forged" } },
      })
    ).config,
  ).toEqual({ ...config, location: { type: "none" } });
  await expect(
    configureIntegration("outlook_calendar", {
      credentials,
      config: { ...config, calendar: { ...calendar, id: "readonly" } },
    }),
  ).rejects.toMatchObject({ code: "resource_not_allowed" });
  await expect(
    configureIntegration("outlook_calendar", {
      credentials,
      config: { ...config, timeZone: "invalid" },
    }),
  ).rejects.toMatchObject({ code: "invalid_config" });
});

test.each([
  "https://attacker.example/steal",
  "http://graph.microsoft.com/v1.0/me/calendars",
  "https://graph.microsoft.com.attacker.example/v1.0/me/calendars",
  "https://user:pass@graph.microsoft.com/v1.0/me/calendars",
])("pagination never forwards credentials to %s", async (nextLink) => {
  const request = respond({ value: [], "@odata.nextLink": nextLink });
  await expect(
    previewIntegration("outlook_calendar", { credentials }),
  ).rejects.toMatchObject({ code: "invalid_provider_response" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
  const slotsRequest = respond({ value: [], "@odata.nextLink": nextLink });
  await expect(
    execute("outlook_calendar.list_slots", context, range),
  ).rejects.toMatchObject({ code: "invalid_provider_response" });
  expect(slotsRequest).toHaveBeenCalledTimes(1);
  const bookingRequest = respond({ value: [], "@odata.nextLink": nextLink });
  await expect(
    execute("outlook_calendar.create_booking", context, appointment),
  ).rejects.toMatchObject({ code: "invalid_provider_response" });
  expect(bookingRequest).toHaveBeenCalledTimes(1);
});

test("malformed, oversized and repeated calendar pages fail closed", async () => {
  for (const payload of [
    {},
    { value: [{ id: "one", name: "Work" }] },
    { value: Array(1001).fill({ id: "one", name: "Work", canEdit: true }) },
  ]) {
    respond(payload);
    await expect(
      previewIntegration("outlook_calendar", { credentials }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  }
  const repeated = {
    value: [],
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars?$skip=1",
  };
  const request = respond(repeated, repeated);
  await expect(
    previewIntegration("outlook_calendar", { credentials }),
  ).rejects.toMatchObject({ code: "invalid_provider_response" });
  expect(request).toHaveBeenCalledTimes(2);
});

test("availability expands recurrences through calendarView, follows pages and respects busy intervals and offsets", async () => {
  const request = respond(
    {
      value: [
        event("2026-10-27T08:15:00.0000000", "2026-10-27T09:00:00.0000000"),
      ],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/me/calendars/one/calendarView?$skip=1",
    },
    {
      value: [
        event("2026-10-27T09:00:00", "2026-10-27T09:30:00", { showAs: "free" }),
        event("2026-10-27T09:00:00", "2026-10-27T10:00:00", {
          isCancelled: true,
        }),
        event("2026-10-27T09:30:00", "2026-10-27T10:00:00", {
          showAs: "tentative",
        }),
        event("2026-10-27T10:00:00", "2026-10-27T10:15:00", { showAs: "oof" }),
      ],
    },
  );
  expect(await execute("outlook_calendar.list_slots", context, range)).toEqual({
    timeZone: config.timeZone,
    slots: [
      { start: "2026-10-27T09:00:00.000Z", end: "2026-10-27T09:30:00.000Z" },
      { start: "2026-10-27T10:15:00.000Z", end: "2026-10-27T10:45:00.000Z" },
    ],
  });
  const url = new URL(request.mock.calls[0]![0]);
  expect(url.pathname).toBe(
    "/v1.0/me/calendars/calendar%2Fone%2B%3D/calendarView",
  );
  expect(url.searchParams.get("startDateTime")).toBe(range.start);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    signal: context.signal,
    headers: {
      Prefer: 'outlook.timezone="UTC"',
      Authorization: "Bearer secret",
    },
  });
});

test("all-day events block slots and empty calendars return at most 20 slots", async () => {
  respond({ value: [event("2026-10-26T23:00:00", "2026-10-27T23:00:00")] });
  expect(
    await execute("outlook_calendar.list_slots", context, range),
  ).toMatchObject({ slots: [] });
  respond({ value: [] });
  const result = await execute("outlook_calendar.list_slots", context, {
    ...range,
    end: "2026-10-28T09:00:00+01:00",
  });
  expect((result as { slots: unknown[] }).slots).toHaveLength(20);
});

test.each([
  {},
  {
    start: utc("invalid"),
    end: utc("2026-10-27T09:00:00"),
    isCancelled: false,
    showAs: "busy",
  },
  event("2026-10-27T09:00:00", "2026-10-27T08:00:00"),
  event("2026-10-27T08:00:00", "2026-10-27T09:00:00", {
    start: { dateTime: "2026-10-27T08:00:00", timeZone: "Europe/Amsterdam" },
  }),
])("invalid availability never offers or books a slot (%j)", async (item) => {
  respond({ value: [item] });
  await expect(
    execute("outlook_calendar.list_slots", context, range),
  ).rejects.toMatchObject({ code: "availability_unavailable" });
  const request = respond({ value: [item] });
  await expect(
    execute("outlook_calendar.create_booking", context, appointment),
  ).rejects.toMatchObject({ code: "availability_unavailable" });
  expect(request.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(
    true,
  );
});

test("invalid input makes no network requests", async () => {
  const request = respond();
  for (const input of [
    { ...range, end: range.start },
    { ...range, duration_minutes: 0 },
    { ...range, end: "2026-12-01T00:00:00Z" },
  ])
    await expect(
      execute("outlook_calendar.list_slots", context, input),
    ).rejects.toMatchObject({ code: "invalid_input" });
  for (const input of [
    { ...appointment, attendee_email: "" },
    { ...appointment, attendee_email: "invalid" },
    { ...appointment, attendee_phone: "123" },
  ])
    await expect(
      execute("outlook_calendar.create_booking", context, input),
    ).rejects.toMatchObject({ code: "invalid_input" });
  expect(request).not.toHaveBeenCalled();
});

function bookingServer() {
  let stored: Record<string, unknown> | undefined;
  const request = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      stored = { ...body, id: "outlook-event", isCancelled: false };
      return Promise.resolve(Response.json(stored, { status: 201 }));
    }
    return Promise.resolve(Response.json({ value: [] }));
  });
  vi.stubGlobal("fetch", request);
  return { request, event: () => stored! };
}

test("booking checks availability, invites the attendee and sends SMS in one attempt", async () => {
  const server = bookingServer();
  const sendSms = vi.fn().mockResolvedValue({ ok: true });
  const bookingContext = {
    ...context,
    config: {
      ...config,
      location: { type: "in_person", address: "Main Street 1" },
    },
    sendSms,
  };
  const input = { ...appointment, attendee_phone: "+31612345678" };
  expect(
    await execute("outlook_calendar.create_booking", bookingContext, input),
  ).toEqual({
    eventId: "outlook-event",
    start: "2026-10-27T08:00:00.000Z",
    end: "2026-10-27T08:30:00.000Z",
    timeZone: config.timeZone,
    location: "Main Street 1",
    sms: { ok: true },
  });
  expect(server.event()).toMatchObject({
    subject: appointment.title,
    start: { dateTime: "2026-10-27T08:00:00.000Z", timeZone: "UTC" },
    showAs: "busy",
    attendees: [
      {
        emailAddress: {
          address: appointment.attendee_email,
          name: appointment.attendee_name,
        },
        type: "required",
      },
    ],
    body: {
      contentType: "text",
      content: expect.stringContaining("+31612345678") as unknown,
    },
  });
  expect(server.event()).not.toHaveProperty("transactionId");
  expect(server.event()).not.toHaveProperty("singleValueExtendedProperties");
  expect(server.request).toHaveBeenCalledTimes(2);
  expect(server.request.mock.calls[0]?.[0]).toContain("calendarView");
  expect(server.request.mock.calls[1]?.[0]).toContain("/events");
  expect(sendSms).toHaveBeenCalledWith({
    to: input.attendee_phone,
    message: expect.stringContaining("09:00 (Europe/Amsterdam)") as unknown,
  });
  expect(
    server.request.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(sendSms).toHaveBeenCalledTimes(1);
});

test("phone-only bookings omit email invitations and preserve booking success when SMS fails", async () => {
  const server = bookingServer();
  const result = await execute(
    "outlook_calendar.create_booking",
    { ...context, sendSms: vi.fn().mockRejectedValue(new Error("SMS failed")) },
    { ...appointment, attendee_email: "", attendee_phone: "+31612345678" },
  );
  expect(result).toMatchObject({
    eventId: "outlook-event",
    sms: { ok: false, error: "sms_delivery_failed" },
  });
  expect(server.event()).not.toHaveProperty("attendees");
});

test("booking refuses a newly occupied slot", async () => {
  const request = respond({
    value: [event("2026-10-27T08:15:00", "2026-10-27T09:00:00")],
  });
  await expect(
    execute("outlook_calendar.create_booking", context, appointment),
  ).rejects.toMatchObject({ code: "booking_conflict" });
  expect(request).toHaveBeenCalledTimes(1);
});

test.each(["network", "server", "malformed", "invalid-json"])(
  "an uncertain %s response does not retry, report booking success or send SMS",
  async (failure) => {
    const request = respond({ value: [] });
    if (failure === "network")
      request.mockRejectedValueOnce(new Error("timeout"));
    else if (failure === "invalid-json")
      request.mockResolvedValueOnce(new Response("invalid", { status: 201 }));
    else
      request.mockResolvedValueOnce(
        Response.json({}, { status: failure === "server" ? 503 : 201 }),
      );
    const sendSms = vi.fn();
    await expect(
      execute(
        "outlook_calendar.create_booking",
        { ...context, sendSms },
        { ...appointment, attendee_phone: "+31612345678" },
      ),
    ).rejects.toMatchObject({ code: "booking_uncertain" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sendSms).not.toHaveBeenCalled();
  },
);

test.each([
  [401, "provider_authentication_failed"],
  [403, "provider_permission_denied"],
  [404, "provider_resource_not_found"],
  [409, "provider_duplicate"],
  [429, "provider_rate_limited"],
  [500, "provider_error"],
])(
  "Graph status %s is mapped without leaking provider data",
  async (status, code) => {
    const error = await provider
      .response(
        Response.json(
          { error: { message: "secret" } },
          { status: Number(status) },
        ),
      )
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("secret");
  },
);
