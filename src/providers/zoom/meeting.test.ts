import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  execute,
  getIntegrationAuth,
  integrationEnvironmentVariables,
} from "@neuroline/integrations";

const input = {
  title: "Consultation",
  start: "2030-06-10T10:30:00+02:00",
  duration_minutes: 30,
};
const context = { credentials: { accessToken: "zoom-token" }, config: {} };
const meeting = {
  id: 12345678901,
  join_url: "https://us02web.zoom.us/j/12345678901?pwd=passcode",
  start_url: "https://us02web.zoom.us/s/12345678901?zak=host-secret",
  password: "private-passcode",
};

beforeEach(() =>
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-06-01T00:00:00Z")),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("creates a scheduled meeting for the connected user and returns only the attendee link", async () => {
  const request = vi.fn().mockResolvedValue(Response.json(meeting));
  vi.stubGlobal("fetch", request);
  await expect(execute("zoom.create_meeting", context, input)).resolves.toEqual(
    {
      id: "12345678901",
      url: meeting.join_url,
    },
  );
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://api.zoom.us/v2/users/me/meetings",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer zoom-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: 2,
        topic: "Consultation",
        start_time: "2030-06-10T08:30:00.000Z",
        duration: 30,
        timezone: "UTC",
        settings: { use_pmi: false },
      }),
    }),
  );
  const auth = getIntegrationAuth("zoom");
  expect(auth.type === "oauth2" && auth.scopes).toEqual([
    "meeting:write:meeting",
  ]);
  expect(integrationEnvironmentVariables).toEqual(
    expect.arrayContaining(["AUTH_ZOOM_ID", "AUTH_ZOOM_SECRET"]),
  );
});

test.each([
  { title: " " },
  { title: "x".repeat(201) },
  { start: "2030-05-01T10:00:00Z" },
  { start: "2030-06-10T10:30:00" },
  { duration_minutes: 0 },
  { duration_minutes: 1441 },
  { duration_minutes: 1.5 },
  { host: "another-user" },
])(
  "rejects invalid meeting details before requesting Zoom: %j",
  async (override) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      execute("zoom.create_meeting", context, { ...input, ...override }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(request).not.toHaveBeenCalled();
  },
);

test.each([
  [400, "provider_request_rejected"],
  [401, "provider_authentication_failed"],
  [403, "provider_permission_denied"],
  [429, "provider_rate_limited"],
  [500, "meeting_creation_uncertain"],
] as const)(
  "handles Zoom HTTP %i without leaking details or retrying",
  async (status, code) => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ message: "host-secret" }, { status }));
    vi.stubGlobal("fetch", request);
    const error: unknown = await execute(
      "zoom.create_meeting",
      context,
      input,
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("host-secret");
    expect(request).toHaveBeenCalledOnce();
  },
);

test.each([
  {},
  { ...meeting, id: -1 },
  { ...meeting, join_url: undefined },
  { ...meeting, join_url: "http://zoom.us/j/123" },
  { ...meeting, join_url: "https://zoom.us.attacker.example/j/123" },
])("treats malformed success responses as uncertain: %j", async (body) => {
  const request = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal("fetch", request);
  await expect(
    execute("zoom.create_meeting", context, input),
  ).rejects.toMatchObject({ code: "meeting_creation_uncertain" });
  expect(request).toHaveBeenCalledOnce();
});

test("does not retry a lost response or replace it with a host link", async () => {
  const request = vi.fn().mockRejectedValue(new TypeError("lost response"));
  vi.stubGlobal("fetch", request);
  await expect(
    execute("zoom.create_meeting", context, input),
  ).rejects.toMatchObject({ code: "meeting_creation_uncertain" });
  expect(request).toHaveBeenCalledOnce();
});
