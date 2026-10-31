import { afterEach, expect, test, vi } from "vitest";
import {
  configureIntegration,
  execute,
  integrationProviderCatalog,
  integrationTools,
} from "@neuroline/integrations";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const context = { credentials: { apiKey: "secret" }, config: {} };
const input = {
  q: "fiets & café",
  country: "NL",
  search_lang: "nl",
  freshness: "pw",
};
const generic = {
  title: "Fietsen in Amsterdam",
  url: "https://example.com/fietsen",
  snippets: ["Bronfragment."],
};
const sources = {
  [generic.url]: { title: generic.title, hostname: "example.com" },
};

test("Brave connects with an API key and registers only LLM Context", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(Response.json({ type: "search" }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    configureIntegration("brave", {
      credentials: { apiKey: " secret " },
      config: {},
    }),
  ).resolves.toEqual(context);
  expect(
    integrationProviderCatalog.find(({ provider }) => provider === "brave"),
  ).toMatchObject({
    category: "knowledge",
    authType: "api_key",
  });
  expect(integrationTools("brave").map(({ name }) => name)).toEqual([
    "llm_context",
  ]);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    "https://api.search.brave.com/res/v1/web/search?q=Brave&count=1",
    expect.objectContaining({
      headers: { Accept: "application/json", "X-Subscription-Token": "secret" },
    }),
  );
});

test("LLM Context calls the matching endpoint and preserves useful source data", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      Response.json({ grounding: { generic: [generic], map: [] }, sources }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  await expect(execute("brave.llm_context", context, input)).resolves.toEqual({
    grounding: { generic: [generic] },
    sources,
  });
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    `https://api.search.brave.com/res/v1/llm/context?${new URLSearchParams({
      ...input,
      count: "5",
      maximum_number_of_urls: "5",
      maximum_number_of_tokens: "2048",
      maximum_number_of_tokens_per_url: "512",
      safesearch: "moderate",
      operators_fallback: "false",
      enable_local: "false",
    }).toString()}`,
    expect.objectContaining({
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": "secret",
      },
      signal: expect.any(AbortSignal) as unknown,
    }),
  );
  expect(timeout).toHaveBeenCalledWith(5_000);
});

test("LLM Context accepts an empty search result", async () => {
  const payload = { grounding: { generic: [] }, sources: {} };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
  await expect(execute("brave.llm_context", context, input)).resolves.toEqual(
    payload,
  );
});

test("LLM Context applies API defaults when locale and freshness are omitted", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      Response.json({ grounding: { generic: [] }, sources: {} }),
    );
  vi.stubGlobal("fetch", fetchMock);
  await execute("brave.llm_context", context, { q: "  Brave  " });
  const url = new URL(fetchMock.mock.calls[0]![0] as string);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    q: "Brave",
    country: "US",
    search_lang: "en",
    freshness: "",
  });
  expect(url.searchParams.has("apiKey")).toBe(false);
});

test.each([
  { ...input, q: " " },
  { ...input, q: "x".repeat(601) },
  { ...input, q: Array(76).fill("x").join(" ") },
  { ...input, country: "Netherlands" },
  { ...input, search_lang: "nl_NL" },
  { ...input, freshness: "tomorrow" },
])("rejects invalid inputs before contacting Brave: %j", async (input) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    execute("brave.llm_context", context, input),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  [401, "UNAUTHORIZED", "provider_authentication_failed"],
  [403, "FORBIDDEN", "provider_authentication_failed"],
  [422, "SUBSCRIPTION_TOKEN_INVALID", "provider_authentication_failed"],
  [422, "VALIDATION", "provider_error"],
  [429, "RATE_LIMITED", "provider_rate_limited"],
  [429, "QUOTA_LIMITED", "provider_rate_limited"],
  [500, "INTERNAL", "provider_error"],
])(
  "handles HTTP %i / %s during connection without exposing provider details",
  async (status, providerCode, code) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: providerCode, detail: "secret" } },
          { status },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      configureIntegration("brave", {
        credentials: context.credentials,
        config: {},
      }),
    ).rejects.toMatchObject({
      code,
      message: `Brave Search request failed (${status})`,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test("LLM Context rejects malformed provider responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ unexpected: true })),
  );
  await expect(execute("brave.llm_context", context, input)).rejects.toThrow();
});

test("invalid JSON is a provider failure, not an empty result", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
  await expect(
    execute("brave.llm_context", context, input),
  ).rejects.toMatchObject({ code: "invalid_provider_response" });
});

test("caps context sources if Brave returns more than requested", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        grounding: { generic: Array.from({ length: 8 }, () => generic) },
        sources,
      }),
    ),
  );
  await expect(execute("brave.llm_context", context, input)).resolves.toEqual({
    grounding: { generic: Array.from({ length: 5 }, () => generic) },
    sources,
  });
});

test("does not contact Brave when the call has already been cancelled", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    execute(
      "brave.llm_context",
      { ...context, signal: AbortSignal.abort() },
      input,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("forwards call cancellation to an in-flight search without retrying", async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const pending = execute(
    "brave.llm_context",
    { ...context, signal: controller.signal },
    input,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchMock).toHaveBeenCalledOnce();
});
