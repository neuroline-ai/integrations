import { afterEach, expect, test, vi } from "vitest";
import {
  configureIntegration,
  execute,
  previewIntegration,
} from "@neuroline/integrations";

const context = {
  credentials: { apiKey: "re_secret" },
  config: { from: "appointments@example.com", domain: null },
};
const domain = { id: "domain-id", title: "example.com" };
const domainResponse = {
  id: domain.id,
  name: domain.title,
  status: "verified",
  capabilities: { sending: "enabled" },
};
const input = {
  to: "caller@example.com",
  subject: "Your appointment",
  text: "Your appointment is confirmed.\nSee you soon!",
};
const email = { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([false, true])(
  "connects without sending email (sending-only key: %s)",
  async (restricted) => {
    const status = restricted ? 401 : 200;
    const body = restricted
      ? { name: "restricted_api_key" }
      : { data: [domainResponse] };
    const request = vi.fn().mockResolvedValue(Response.json(body, { status }));
    vi.stubGlobal("fetch", request);
    await expect(
      configureIntegration("resend", {
        credentials: { apiKey: " re_secret " },
        config: {
          from: " appointments@example.com ",
          domain: restricted ? null : domain,
        },
      }),
    ).resolves.toEqual({
      ...context,
      config: { ...context.config, domain: restricted ? null : domain },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "https://api.resend.com/domains",
      expect.objectContaining({
        redirect: "error",
        headers: { Authorization: "Bearer re_secret" },
      }),
    );
  },
);

test("lists only verified sending domains and keeps an empty list distinct from restricted access", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: [
          domainResponse,
          { ...domainResponse, id: "pending", status: "pending" },
          {
            ...domainResponse,
            id: "receiving",
            capabilities: { sending: "disabled" },
          },
          { ...domainResponse, id: "other", name: "Alpha.example.com" },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(
      Response.json({ name: "restricted_api_key" }, { status: 401 }),
    );
  vi.stubGlobal("fetch", request);
  await expect(previewIntegration("resend", context)).resolves.toEqual({
    domain: [{ id: "other", title: "alpha.example.com" }, domain],
  });
  await expect(previewIntegration("resend", context)).resolves.toEqual({
    domain: [],
  });
  await expect(previewIntegration("resend", context)).resolves.toEqual({
    domain: null,
  });
});

test.each([
  { domain: null, from: "appointments@example.com" },
  {
    domain: { ...domain, id: "another-account" },
    from: "appointments@example.com",
  },
  { domain, from: "appointments@other.example" },
  {
    domain: { ...domain, title: "other.example" },
    from: "appointments@other.example",
  },
])(
  "rejects missing, unavailable or forged domain selections: %j",
  async (config) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ data: [domainResponse] })),
    );
    await expect(
      configureIntegration("resend", { ...context, config }),
    ).rejects.toThrow();
  },
);

test("rejects a domain that stopped being verified before saving", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: [{ ...domainResponse, status: "pending" }],
      }),
    ),
  );
  await expect(
    configureIntegration("resend", {
      ...context,
      config: { ...context.config, domain },
    }),
  ).rejects.toMatchObject({
    code: "resource_not_allowed",
    fields: ["config.domain"],
  });
});

test("sending-only keys allow manual senders but cannot claim a listed domain", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ name: "restricted_api_key" }, { status: 401 }),
        ),
      ),
  );
  await expect(
    configureIntegration("resend", {
      ...context,
      config: { from: context.config.from },
    }),
  ).resolves.toEqual(context);
  await expect(
    configureIntegration("resend", {
      ...context,
      config: { ...context.config, domain },
    }),
  ).rejects.toMatchObject({ code: "resource_not_allowed" });
});

test.each([
  [400, "validation_error"],
  [401, "validation_error"],
  [401, "missing_api_key"],
  [403, "restricted_api_key"],
  [403, "suspended_api_key"],
  [429, "rate_limit_exceeded"],
  [500, "application_error"],
])("rejects unusable keys during setup (%i, %s)", async (status, name) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ name, message: "re_secret" }, { status }),
      ),
  );
  await expect(configureIntegration("resend", context)).rejects.toThrow(
    `Resend request failed (${status})`,
  );
});

test.each([
  {},
  null,
  { data: "invalid" },
  { has_more: true, data: [] },
  { data: [domainResponse, domainResponse] },
])("rejects malformed credential-check responses: %j", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
  await expect(configureIntegration("resend", context)).rejects.toThrow();
});

test("sends the API payload in one attempt", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(Response.json({ ...email, private: "secret" }));
  vi.stubGlobal("fetch", request);
  const signal = new AbortController().signal;
  await expect(
    execute("resend.send_email", { ...context, signal }, input),
  ).resolves.toEqual(email);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://api.resend.com/emails",
    {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer re_secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: context.config.from, ...input }),
      signal,
    },
  );
});

test.each([
  { to: "invalid" },
  { to: ["caller@example.com"] },
  { to: "caller@example.com\r\nBcc: other@example.com" },
  { subject: " " },
  { subject: "x".repeat(501) },
  { subject: "Subject\r\nBcc: other@example.com" },
  { text: " " },
  { text: "x".repeat(50_001) },
  { from: "other@example.com" },
  { html: "<p>Unexpected</p>" },
])("rejects invalid email details before sending: %#", async (override) => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  await expect(
    execute("resend.send_email", context, { ...input, ...override }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(request).not.toHaveBeenCalled();
});

test.each([
  { credentials: { apiKey: " " }, config: context.config },
  { credentials: context.credentials, config: {} },
  { credentials: context.credentials, config: { from: "invalid" } },
])(
  "rejects invalid connection details before sending: %j",
  async (connection) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      execute("resend.send_email", connection, input),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  },
);

test.each([
  [400, "provider_request_rejected"],
  [401, "provider_authentication_failed"],
  [403, "provider_permission_denied"],
  [408, "email_sending_uncertain"],
  [409, "email_sending_uncertain"],
  [422, "provider_request_rejected"],
  [429, "provider_rate_limited"],
  [500, "email_sending_uncertain"],
])(
  "handles HTTP %i without leaking details or retrying",
  async (status, code) => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ message: "re_secret" }, { status }));
    vi.stubGlobal("fetch", request);
    const error: unknown = await execute(
      "resend.send_email",
      context,
      input,
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("re_secret");
    expect(request).toHaveBeenCalledOnce();
  },
);

test.each([{}, { id: "" }, { id: "invalid" }, { id: 123 }])(
  "treats malformed success responses as uncertain without retrying: %j",
  async (body) => {
    const request = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", request);
    await expect(
      execute("resend.send_email", context, input),
    ).rejects.toMatchObject({
      code: "email_sending_uncertain",
    });
    expect(request).toHaveBeenCalledOnce();
  },
);

test("does not retry a lost response or invalid JSON", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("lost response"))
    .mockResolvedValueOnce(new Response("not JSON"));
  vi.stubGlobal("fetch", request);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await expect(
      execute("resend.send_email", context, input),
    ).rejects.toMatchObject({
      code: "email_sending_uncertain",
    });
    expect(request).toHaveBeenCalledTimes(attempt);
  }
});

test("does not send when the call has already been cancelled", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  await expect(
    execute(
      "resend.send_email",
      { ...context, signal: AbortSignal.abort() },
      input,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(request).not.toHaveBeenCalled();
});
