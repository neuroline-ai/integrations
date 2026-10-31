import { afterEach, expect, test, vi } from "vitest";
import {
  exchangeOAuthTokens,
  oauthAuthorizationUrl,
  type OAuthTokens,
} from "@neuroline/integrations";
import provider from "../dist/providers/google_calendar/_provider.js";
import zoom from "../dist/providers/zoom/_provider.js";
import outlook from "../dist/providers/outlook_calendar/_provider.js";

const auth = provider.auth;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const context = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://app.example/api/integrations/oauth",
  signal: new AbortController().signal,
};
const tokens: OAuthTokens = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: 1,
  scopes: auth.scopes,
};
const respond = (payload: unknown, status = 200) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

test("Google Calendar uses PKCE, offline consent, fixed endpoints and narrow scopes", () => {
  const url = new URL(
    oauthAuthorizationUrl(auth, {
      ...context,
      state: "state",
      challenge: "challenge",
    }),
  );
  expect(url.origin + url.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    state: "state",
    scope: auth.scopes.join(" "),
  });
  expect(auth.tokenUrl).toBe("https://oauth2.googleapis.com/token");
  expect(auth.scopes).not.toContain("https://www.googleapis.com/auth/calendar");
});

test("Zoom authorization preserves state and PKCE", () => {
  const url = new URL(
    oauthAuthorizationUrl(zoom.auth, {
      ...context,
      state: "state",
      challenge: "challenge",
    }),
  );
  expect(url.origin + url.pathname).toBe("https://zoom.us/oauth/authorize");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: "client",
    state: "state",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    scope: "meeting:write:meeting",
  });
});

test("Outlook uses Microsoft credentials, delegated calendar access, offline consent and PKCE", () => {
  const url = new URL(
    oauthAuthorizationUrl(outlook.auth, {
      ...context,
      state: "state",
      challenge: "challenge",
    }),
  );
  expect(outlook.auth.clientIdEnv).toBe("AUTH_MICROSOFT_ID");
  expect(outlook.auth.clientSecretEnv).toBe("AUTH_MICROSOFT_SECRET");
  expect(url.origin + url.pathname).toBe(
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  );
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    response_mode: "query",
    prompt: "select_account",
    state: "state",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    scope: "Calendars.ReadWrite offline_access",
  });
});

test.each(["code", "refresh"])(
  "Outlook %s exchange accepts access-token scopes without offline_access and rotates refresh tokens",
  async (grant) => {
    const request = respond({
      access_token: "outlook-access",
      refresh_token: "outlook-refresh",
      expires_in: 3600,
      scope: "Calendars.ReadWrite",
    });
    const grantContext = {
      ...context,
      grant:
        grant === "code"
          ? { code: "code", verifier: "verifier" }
          : { tokens: { ...tokens, scopes: ["Calendars.ReadWrite"] } },
    };
    await expect(
      exchangeOAuthTokens(outlook.auth, grantContext),
    ).resolves.toMatchObject({
      accessToken: "outlook-access",
      refreshToken: "outlook-refresh",
      scopes: ["Calendars.ReadWrite"],
    });
    expect(request).toHaveBeenCalledWith(
      outlook.auth.tokenUrl,
      expect.objectContaining({ redirect: "error" }),
    );
    const [, init] = request.mock.calls[0] as [string, RequestInit];
    expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({
      client_id: "client",
      client_secret: "secret",
    });
    respond({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "Calendars.Read",
    });
    await expect(
      exchangeOAuthTokens(outlook.auth, grantContext),
    ).rejects.toMatchObject({ code: "oauth_reconnect_required" });
  },
);

test("Outlook still requires a refresh token for offline access", async () => {
  respond({
    access_token: "access",
    expires_in: 3600,
    scope: "Calendars.ReadWrite",
  });
  await expect(
    exchangeOAuthTokens(outlook.auth, {
      ...context,
      grant: { code: "code", verifier: "verifier" },
    }),
  ).rejects.toMatchObject({ code: "oauth_reconnect_required" });
});

test.each(["code", "refresh"])(
  "Zoom uses Basic authentication for %s exchange and retains rotated tokens",
  async (grant) => {
    const request = respond({
      access_token: "zoom-access",
      refresh_token: "zoom-refresh",
      expires_in: 3600,
      scope: "meeting:write:meeting",
    });
    await expect(
      exchangeOAuthTokens(zoom.auth, {
        ...context,
        grant:
          grant === "code"
            ? { code: "code", verifier: "verifier" }
            : { tokens: { ...tokens, scopes: zoom.auth.scopes } },
      }),
    ).resolves.toMatchObject({
      accessToken: "zoom-access",
      refreshToken: "zoom-refresh",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "https://zoom.us/oauth/token",
      expect.objectContaining({
        redirect: "error",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa("client:secret")}`,
        },
      }),
    );
    const [, init] = request.mock.calls[0] as [string, RequestInit];
    const body = Object.fromEntries(init.body as URLSearchParams);
    expect(body).not.toHaveProperty("client_secret");
    expect(body).not.toHaveProperty("client_id");
    expect(body).toMatchObject(
      grant === "code"
        ? {
            grant_type: "authorization_code",
            code: "code",
            code_verifier: "verifier",
            redirect_uri: context.redirectUri,
          }
        : { grant_type: "refresh_token", refresh_token: "old-refresh" },
    );
  },
);

test("code exchange stores expiry in milliseconds; refresh preserves or rotates the refresh token", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const fetchMock = respond({
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
  const connected = await exchangeOAuthTokens(auth, {
    ...context,
    grant: { code: "code", verifier: "verifier" },
  });
  expect(connected).toMatchObject({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 4_600_000,
  });
  const request = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(Object.fromEntries(request[1].body as URLSearchParams)).toMatchObject({
    client_id: "client",
    client_secret: "secret",
    grant_type: "authorization_code",
    code_verifier: "verifier",
    code: "code",
  });
  expect(request[1].redirect).toBe("error");

  respond({ access_token: "new-access", expires_in: "3600" });
  await expect(
    exchangeOAuthTokens(auth, {
      ...context,
      grant: { tokens },
    }),
  ).resolves.toMatchObject({
    accessToken: "new-access",
    refreshToken: "old-refresh",
  });
  respond({
    access_token: "new-access",
    refresh_token: "rotated",
    expires_in: 3600,
  });
  await expect(
    exchangeOAuthTokens(auth, {
      ...context,
      grant: { tokens },
    }),
  ).resolves.toMatchObject({ refreshToken: "rotated" });

  const tokenUrl = "https://oauth2.googleapis.com/token";
  const staticEndpoint = respond({
    access_token: "new-access",
    expires_in: 3600,
  });
  await exchangeOAuthTokens(
    { ...auth, tokenUrl },
    {
      ...context,
      grant: { tokens },
    },
  );
  expect(staticEndpoint).toHaveBeenCalledWith(tokenUrl, expect.any(Object));
});

test("revocation needs reconnection, but malformed and temporary responses remain retryable without leaking secrets", async () => {
  for (const [payload, status, code] of [
    [
      { error: "invalid_grant", error_description: "sensitive" },
      400,
      "oauth_reconnect_required",
    ],
    [
      { error: "unavailable", error_description: "sensitive" },
      503,
      "oauth_refresh_failed",
    ],
    [
      { access_token: "sensitive", expires_in: -1 },
      200,
      "invalid_provider_response",
    ],
    [
      { access_token: null, expires_in: 3600 },
      200,
      "invalid_provider_response",
    ],
    [
      { access_token: "sensitive", expires_in: 3600, scope: "unrelated" },
      200,
      "oauth_reconnect_required",
    ],
  ] as const) {
    respond(payload, status);
    const error: unknown = await exchangeOAuthTokens(auth, {
      ...context,
      grant: { tokens },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("sensitive");
  }
  respond({
    access_token: "sensitive",
    expires_in: 3600,
  });
  await expect(
    exchangeOAuthTokens(auth, {
      ...context,
      grant: { code: "code", verifier: "verifier" },
    }),
  ).rejects.toMatchObject({ code: "oauth_reconnect_required" });
});
