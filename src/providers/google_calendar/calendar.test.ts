import { afterEach, expect, test, vi } from "vitest";
import {
  configureIntegration,
  execute,
  previewIntegration,
  type SendSms,
} from "@neuroline/integrations";
import provider from "./_provider.ts";

const calendarId = "business@example.com";
const config = {
  calendar: { id: calendarId, title: "Business", timeZone: "Europe/Amsterdam" },
};
const credentials = { accessToken: "secret" };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("setup follows calendar pages, restricts writes to one verified calendar", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        items: [
          {
            id: "read-only",
            summary: "Read only",
            timeZone: "UTC",
            accessRole: "reader",
          },
        ],
        nextPageToken: "next",
      }),
    )
    .mockResolvedValueOnce(
      json({
        items: [
          {
            id: calendarId,
            summary: "Business",
            timeZone: "Europe/Amsterdam",
            accessRole: "writer",
          },
        ],
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const resources = await previewIntegration("google_calendar", {
    credentials,
  });
  expect(resources).toEqual({
    calendar: [
      {
        id: calendarId,
        title: "Business",
        timeZone: "Europe/Amsterdam",
      },
    ],
  });
  expect(fetchMock.mock.calls[1]?.[0]).toContain("pageToken=next");
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      json({
        items: [
          {
            id: calendarId,
            summary: "Business",
            timeZone: "Europe/Amsterdam",
            accessRole: "writer",
          },
        ],
      }),
    ),
  );
  const setup = {
    credentials,
    config,
  };
  expect((await configureIntegration("google_calendar", setup)).config).toEqual(
    { ...config, location: { type: "none" } },
  );
  await expect(
    configureIntegration("google_calendar", {
      ...setup,
      config: { calendar: { ...config.calendar, id: "other" } },
    }),
  ).rejects.toMatchObject({ code: "resource_not_allowed" });
  await expect(
    configureIntegration("google_calendar", {
      ...setup,
      config: { calendar: [config.calendar, config.calendar] },
    }),
  ).rejects.toMatchObject({ code: "invalid_config" });
  const configured = await configureIntegration("google_calendar", {
    ...setup,
    config: {
      ...config,
      location: { type: "in_person", address: "  Main Street 1  " },
    },
  });
  expect(configured.config).toEqual({
    ...config,
    location: { type: "in_person", address: "Main Street 1" },
  });
  await expect(
    configureIntegration("google_calendar", {
      ...setup,
      config: { ...config, location: { type: "in_person", address: " " } },
    }),
  ).rejects.toMatchObject({ code: "invalid_config" });
  const forged = {
    calendar: { ...config.calendar, title: "Forged", timeZone: "UTC" },
  };
  expect(
    (
      await configureIntegration("google_calendar", {
        credentials,
        config: forged,
      })
    ).config,
  ).toEqual({ ...config, location: { type: "none" } });
  expect(forged.calendar.title).toBe("Forged");
  expect(
    (
      await configureIntegration("google_calendar", {
        credentials,
        config: configured.config,
      })
    ).config,
  ).toEqual(configured.config);
  for (const invalid of [
    null,
    [],
    {},
    { calendar: null },
    { calendar: "calendar" },
    { calendar: {} },
  ]) {
    await expect(
      configureIntegration("google_calendar", { credentials, config: invalid }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  }
});

function bookingCalendar() {
  let event: Record<string, unknown> | undefined;
  const request = vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith("/freeBusy"))
      return Promise.resolve(
        json({ calendars: { [calendarId]: { busy: [] } } }),
      );
    event = {
      ...JSON.parse(init.body as string),
      id: "google-event",
      status: "confirmed",
    } as Record<string, unknown>;
    return Promise.resolve(json(event));
  });
  vi.stubGlobal("fetch", request);
  return { request, event: () => event };
}

const appointment = {
  start: "2026-09-07T07:00:00Z",
  title: "Consultation",
  duration_minutes: 30,
  attendee_name: "Caller",
  attendee_phone: "+31612345678",
};

test.each([
  [{ type: "none" }, undefined],
  [{ type: "in_person", address: "Main Street 1" }, "Main Street 1"],
  [
    { type: "online", provider: "google_meet" },
    "https://meet.google.com/abc-defg-hij",
  ],
  [
    { type: "online", provider: "zoom" },
    "https://us02web.zoom.us/j/12345678901?pwd=passcode",
  ],
] as const)(
  "books and texts the configured location %j in one attempt",
  async (location, expectedLocation) => {
    const calendar = bookingCalendar();
    const executeAction = vi.fn().mockResolvedValue({
      id: "spaces/meeting",
      url: expectedLocation,
    });
    const sendSms = vi
      .fn<SendSms>()
      .mockResolvedValue({ ok: true, result: { sent: true } });
    const context = {
      credentials,
      config: { ...config, location },
      execute: executeAction,
      sendSms,
    };
    const result = await execute(
      "google_calendar.create_booking",
      context,
      appointment,
    );
    expect(result).toMatchObject({
      sms: { ok: true },
    });
    expect(result).toHaveProperty("eventId", "google-event");
    expect(calendar.event()?.location).toBe(expectedLocation);
    expect(calendar.event()?.conferenceData).toBeUndefined();
    expect(executeAction).toHaveBeenCalledTimes(
      typeof location === "object" && location?.type === "online" ? 1 : 0,
    );
    if (typeof location === "object" && location?.type === "online")
      expect(executeAction).toHaveBeenCalledWith(
        `${location.provider}.create_meeting`,
        location.provider === "google_meet"
          ? {}
          : {
              title: appointment.title,
              start: appointment.start,
              duration_minutes: appointment.duration_minutes,
            },
      );
    expect(sendSms).toHaveBeenCalledOnce();
    expect(sendSms.mock.calls[0]![0].to).toBe(appointment.attendee_phone);
    expect(sendSms.mock.calls[0]![0].message).toContain(
      "09:00 (Europe/Amsterdam)",
    );
    if (expectedLocation)
      expect(sendSms.mock.calls[0]![0].message).toContain(expectedLocation);
    expect(calendar.request).toHaveBeenCalledTimes(2);
    expect(calendar.request.mock.calls[0]![0]).toContain("/freeBusy");
    expect(calendar.request.mock.calls[1]![0]).toContain("/events?");
    const body: unknown = JSON.parse(
      calendar.request.mock.calls[1]![1].body as string,
    );
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("extendedProperties");
  },
);

test("SMS failures preserve successful bookings", async () => {
  const calendar = bookingCalendar();
  await expect(
    execute(
      "google_calendar.create_booking",
      {
        credentials,
        config,
        sendSms: vi
          .fn()
          .mockRejectedValue(new Error("private transport error")),
      },
      appointment,
    ),
  ).resolves.toMatchObject({
    sms: { ok: false, error: "sms_delivery_failed" },
  });
  expect(calendar.event()).toBeDefined();
});

test("a missing meeting provider fails before creating an event", async () => {
  const calendar = bookingCalendar();
  await expect(
    execute(
      "google_calendar.create_booking",
      {
        credentials,
        config: {
          ...config,
          location: { type: "online", provider: "google_meet" },
        },
      },
      appointment,
    ),
  ).rejects.toMatchObject({ code: "integration_unavailable" });
  expect(calendar.event()).toBeUndefined();
});

test("meeting failures do not create events or send confirmations", async () => {
  const calendar = bookingCalendar();
  const executeAction = vi
    .fn()
    .mockRejectedValue(new Error("Meeting creation uncertain"));
  const sendSms = vi.fn();
  await expect(
    execute(
      "google_calendar.create_booking",
      {
        credentials,
        config: {
          ...config,
          location: { type: "online", provider: "google_meet" },
        },
        execute: executeAction,
        sendSms,
      },
      appointment,
    ),
  ).rejects.toThrow("Meeting creation uncertain");
  expect(executeAction).toHaveBeenCalledOnce();
  expect(calendar.event()).toBeUndefined();
  expect(sendSms).not.toHaveBeenCalled();
});

test.each([
  { id: "meeting", url: "http://meet.google.com/abc-defg-hij" },
  { id: "", url: "https://meet.google.com/abc-defg-hij" },
  { id: "meeting" },
])(
  "invalid meeting results do not create events or send confirmations: %j",
  async (meeting) => {
    const calendar = bookingCalendar();
    const sendSms = vi.fn();
    await expect(
      execute(
        "google_calendar.create_booking",
        {
          credentials,
          config: {
            ...config,
            location: { type: "online", provider: "google_meet" },
          },
          execute: vi.fn().mockResolvedValue(meeting),
          sendSms,
        },
        appointment,
      ),
    ).rejects.toThrow();
    expect(calendar.event()).toBeUndefined();
    expect(sendSms).not.toHaveBeenCalled();
  },
);

test("reports partial failure after meeting creation without retrying or sending SMS", async () => {
  const calendar = bookingCalendar();
  const original = calendar.request.getMockImplementation()!;
  calendar.request.mockImplementation((url, init) => {
    if (url.includes("/events?") && init.method === "POST")
      throw new TypeError("lost response");
    return original(url, init);
  });
  const executeAction = vi.fn().mockResolvedValue({
    id: "spaces/meeting",
    url: "https://meet.google.com/abc-defg-hij",
  });
  const sendSms = vi.fn();
  await expect(
    execute(
      "google_calendar.create_booking",
      {
        credentials,
        config: {
          ...config,
          location: { type: "online", provider: "google_meet" },
        },
        execute: executeAction,
        sendSms,
      },
      appointment,
    ),
  ).rejects.toMatchObject({ code: "booking_uncertain" });
  expect(executeAction).toHaveBeenCalledOnce();
  expect(sendSms).not.toHaveBeenCalled();
});

test("books without SMS when the phone number or sender is absent", async () => {
  bookingCalendar();
  const sendSms = vi.fn();
  await expect(
    execute(
      "google_calendar.create_booking",
      { credentials, config, sendSms },
      {
        ...appointment,
        attendee_phone: "",
        attendee_email: "caller@example.com",
      },
    ),
  ).resolves.not.toHaveProperty("sms");
  bookingCalendar();
  await expect(
    execute(
      "google_calendar.create_booking",
      { credentials, config },
      appointment,
    ),
  ).resolves.not.toHaveProperty("sms");
  expect(sendSms).not.toHaveBeenCalled();
});

test("slots use the requested range and duration without scheduling policies", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(json({ calendars: { [calendarId]: { busy: [] } } })),
    );
  vi.stubGlobal("fetch", fetchMock);
  const range = {
    start: "2026-03-29T01:15:00Z",
    end: "2026-03-29T03:15:00Z",
    duration_minutes: 45,
  };
  await expect(
    execute("google_calendar.list_slots", { credentials, config }, range),
  ).resolves.toEqual({
    timeZone: "Europe/Amsterdam",
    slots: [
      { start: "2026-03-29T01:15:00.000Z", end: "2026-03-29T02:00:00.000Z" },
      { start: "2026-03-29T02:00:00.000Z", end: "2026-03-29T02:45:00.000Z" },
    ],
  });
  const request: unknown = JSON.parse(
    fetchMock.mock.calls[0]![1]!.body as string,
  );
  expect(request).toMatchObject({
    timeMin: "2026-03-29T01:15:00.000Z",
    timeMax: "2026-03-29T03:15:00.000Z",
    items: [{ id: calendarId }],
  });
  fetchMock.mockResolvedValueOnce(
    json({
      calendars: {
        [calendarId]: {
          busy: [
            { start: "2026-03-29T02:00:00Z", end: "2026-03-29T02:30:00Z" },
          ],
        },
      },
    }),
  );
  await expect(
    execute(
      "google_calendar.list_slots",
      { credentials, config },
      { ...range, duration_minutes: 30 },
    ),
  ).resolves.toMatchObject({
    slots: [
      { start: "2026-03-29T01:15:00.000Z", end: "2026-03-29T01:45:00.000Z" },
      { start: "2026-03-29T02:30:00.000Z", end: "2026-03-29T03:00:00.000Z" },
    ],
  });
  for (const duration_minutes of [0, -1, 1.5])
    await expect(
      execute(
        "google_calendar.list_slots",
        { credentials, config },
        { ...range, duration_minutes },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    execute(
      "google_calendar.list_slots",
      { credentials, config },
      { start: range.start, end: range.end },
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    execute(
      "google_calendar.list_slots",
      { credentials, config },
      { ...range, end: "2026-05-01T00:00:00Z" },
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

test.each([
  {},
  { errors: [{ reason: "notFound" }] },
  { busy: [], errors: [{ reason: "notFound" }] },
  { busy: [{ start: "2026-09-07T08:00:00Z", end: "2026-09-07T07:00:00Z" }] },
])(
  "unverifiable availability blocks listing and creation: %j",
  async (availability) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("/freeBusy")
            ? json({ calendars: { [calendarId]: availability } })
            : json({}, 404),
        ),
      ),
    );
    const context = { credentials, config };
    await expect(
      execute("google_calendar.list_slots", context, {
        start: "2026-09-07T07:00:00Z",
        end: "2026-09-07T09:00:00Z",
        duration_minutes: 30,
      }),
    ).rejects.toMatchObject({ code: "availability_unavailable" });
    await expect(
      execute("google_calendar.create_booking", context, {
        start: "2026-09-07T07:00:00Z",
        title: "Consultation",
        duration_minutes: 30,
        attendee_name: "Caller",
        attendee_phone: "+31612345678",
      }),
    ).rejects.toMatchObject({ code: "availability_unavailable" });
  },
);

test("booking invites supplied attendees and refuses a newly occupied slot", async () => {
  const calendar = bookingCalendar();
  const input = {
    ...appointment,
    description: "Discuss the project",
    attendee_email: "caller@example.com",
    attendee_phone: "",
  };
  const context = { credentials, config };
  for (const invalid of [
    { duration_minutes: 0 },
    { attendee_email: "invalid" },
  ])
    await expect(
      execute("google_calendar.create_booking", context, {
        ...input,
        ...invalid,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  expect(calendar.request).not.toHaveBeenCalled();
  await expect(
    execute("google_calendar.create_booking", context, input),
  ).resolves.toMatchObject({
    eventId: "google-event",
    start: "2026-09-07T07:00:00.000Z",
    end: "2026-09-07T07:30:00.000Z",
    timeZone: "Europe/Amsterdam",
  });
  expect(calendar.event()).toMatchObject({
    summary: "Consultation",
    description: "Discuss the project",
    attendees: [{ email: "caller@example.com", displayName: "Caller" }],
  });
  expect(calendar.request.mock.calls[1]![0]).toContain(
    "business%40example.com/events?sendUpdates=all",
  );
  calendar.request.mockClear();
  calendar.request.mockResolvedValueOnce(
    json({
      calendars: {
        [calendarId]: {
          busy: [
            { start: "2026-09-07T07:00:00Z", end: "2026-09-07T07:30:00Z" },
          ],
        },
      },
    }),
  );
  await expect(
    execute("google_calendar.create_booking", context, input),
  ).rejects.toMatchObject({ code: "booking_conflict" });
  expect(calendar.request).toHaveBeenCalledOnce();
  expect(calendar.request.mock.calls[0]![0]).toContain("/freeBusy");
});

test.each(["network", "server", "malformed", "invalid-json"])(
  "an uncertain %s response does not retry, report booking success or send SMS",
  async (failure) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        json({ calendars: { [calendarId]: { busy: [] } } }),
      );
    if (failure === "network")
      request.mockRejectedValueOnce(new Error("timeout"));
    else if (failure === "invalid-json")
      request.mockResolvedValueOnce(new Response("invalid", { status: 201 }));
    else
      request.mockResolvedValueOnce(json({}, failure === "server" ? 503 : 201));
    vi.stubGlobal("fetch", request);
    const sendSms = vi.fn();
    await expect(
      execute(
        "google_calendar.create_booking",
        { credentials, config, sendSms },
        appointment,
      ),
    ).rejects.toMatchObject({ code: "booking_uncertain" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sendSms).not.toHaveBeenCalled();
  },
);

test.each([
  [400, "provider_error"],
  [409, "provider_duplicate"],
  [422, "provider_error"],
] as const)(
  "a rejected booking preserves HTTP %i without a recovery lookup",
  async (status, code) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        json({ calendars: { [calendarId]: { busy: [] } } }),
      )
      .mockResolvedValueOnce(json({}, status));
    vi.stubGlobal("fetch", request);
    const sendSms = vi.fn();
    await expect(
      execute(
        "google_calendar.create_booking",
        { credentials, config, sendSms },
        appointment,
      ),
    ).rejects.toMatchObject({
      code,
      message: `Google Calendar request failed (${status})`,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sendSms).not.toHaveBeenCalled();
  },
);

test("a rejected booking preserves the error and reports an already created meeting", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(json({ calendars: { [calendarId]: { busy: [] } } }))
    .mockResolvedValueOnce(json({}, 400));
  vi.stubGlobal("fetch", request);
  const executeAction = vi.fn().mockResolvedValue({
    id: "spaces/meeting",
    url: "https://meet.google.com/abc-defg-hij",
  });
  const sendSms = vi.fn();
  await expect(
    execute(
      "google_calendar.create_booking",
      {
        credentials,
        config: {
          ...config,
          location: { type: "online", provider: "google_meet" },
        },
        execute: executeAction,
        sendSms,
      },
      appointment,
    ),
  ).rejects.toMatchObject({
    code: "provider_error",
    message:
      "Google Calendar request failed (400). A meeting link was created; verify it before retrying.",
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(executeAction).toHaveBeenCalledOnce();
  expect(sendSms).not.toHaveBeenCalled();
});

test("phone-only bookings use function parameters without scheduling rules and rate limits are distinct from authorization failures", async () => {
  const fetchMock = vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith("/freeBusy"))
      return json({ calendars: { [calendarId]: { busy: [] } } });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.attendees).toBeUndefined();
    expect(body.description).toBe("Discuss the project\n\nPhone: +31612345678");
    return json({ ...body, id: "google-event", status: "confirmed" });
  });
  vi.stubGlobal("fetch", fetchMock);
  const context = {
    credentials,
    config,
  };
  const input = {
    start: "2026-09-07T07:00:00Z",
    title: "Consultation",
    duration_minutes: 30,
    description: "Discuss the project",
    attendee_name: "Caller",
    attendee_phone: "+31612345678",
  };
  await expect(
    execute("google_calendar.create_booking", context, input),
  ).resolves.toMatchObject({ timeZone: "Europe/Amsterdam" });
  const writes = fetchMock.mock.calls.filter(
    ([url, init]) => init.method === "POST" && url.includes("/events?"),
  );
  expect(writes).toHaveLength(1);
  for (const start of [
    "2026-09-07T03:00:00Z", // Before opening.
    "2026-09-07T07:15:00Z", // Outside the appointment grid.
    "2026-09-07T07:00:01Z", // Not an exact slot start.
    "2026-09-07T15:00:00Z", // After closing.
    "2026-09-12T07:00:00Z", // Closed Saturday.
    "2026-10-07T07:00:00Z", // Beyond the booking horizon.
  ]) {
    await expect(
      execute("google_calendar.create_booking", context, { ...input, start }),
    ).resolves.toHaveProperty("eventId");
  }
  await expect(
    provider.response(
      json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403),
    ),
  ).rejects.toMatchObject({ code: "provider_rate_limited" });
  await expect(provider.response(json({}, 403))).rejects.toMatchObject({
    code: "provider_permission_denied",
  });
  await expect(provider.response(json({}, 401))).rejects.toMatchObject({
    code: "provider_authentication_failed",
  });
});
