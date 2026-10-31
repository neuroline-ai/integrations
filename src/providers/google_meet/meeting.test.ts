import { afterEach, expect, test, vi } from "vitest";
import { execute, getIntegrationAuth } from "@neuroline/integrations";

afterEach(() => vi.unstubAllGlobals());

test("creates a standalone Meet space with its own OAuth scope", async () => {
  const request = vi.fn().mockResolvedValue(
    Response.json({
      name: "spaces/meeting",
      meetingUri: "https://meet.google.com/abc-defg-hij",
    }),
  );
  vi.stubGlobal("fetch", request);
  const auth = getIntegrationAuth("google_meet");
  expect(auth.type === "oauth2" && auth.scopes).toEqual([
    "https://www.googleapis.com/auth/meetings.space.created",
  ]);
  await expect(
    execute(
      "google_meet.create_meeting",
      {
        credentials: { accessToken: "meet-token" },
        config: {},
      },
      {},
    ),
  ).resolves.toEqual({
    id: "spaces/meeting",
    url: "https://meet.google.com/abc-defg-hij",
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://meet.googleapis.com/v2/spaces",
    expect.objectContaining({
      method: "POST",
      body: "{}",
      headers: {
        Authorization: "Bearer meet-token",
        "content-type": "application/json",
      },
    }),
  );
});

test.each([
  {},
  { name: "spaces/meeting", meetingUri: "https://untrusted.example/meet" },
])("rejects invalid Meet responses without retrying: %j", async (body) => {
  const request = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal("fetch", request);
  await expect(
    execute(
      "google_meet.create_meeting",
      { credentials: { accessToken: "token" }, config: {} },
      {},
    ),
  ).rejects.toMatchObject({ code: "meeting_creation_uncertain" });
  expect(request).toHaveBeenCalledOnce();
});

test("does not retry an uncertain meeting creation", async () => {
  const request = vi.fn().mockRejectedValue(new TypeError("connection lost"));
  vi.stubGlobal("fetch", request);
  await expect(
    execute(
      "google_meet.create_meeting",
      { credentials: { accessToken: "token" }, config: {} },
      {},
    ),
  ).rejects.toMatchObject({ code: "meeting_creation_uncertain" });
  expect(request).toHaveBeenCalledOnce();
});
