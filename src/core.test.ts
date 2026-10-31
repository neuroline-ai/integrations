import { z } from "zod";
import { afterEach, expect, expectTypeOf, test, vi } from "vitest";

import {
  configureIntegration,
  defineProvider,
  execute,
  getIntegrationDependencies,
  integrationCatalog,
  integrationProviderCatalog,
  integrationTools,
  isIntegrationConfigured,
  previewIntegration,
  type IntegrationActionId,
  type IntegrationProviderId,
} from "@neuroline/integrations";
import {
  createIntegrationRuntime,
  setupDefaults,
  setupDependencies,
} from "../dist/core.js";
import {
  integrationCatalog as browserActions,
  integrationProviderCatalog as browserCatalog,
} from "@neuroline/integrations/browser";
import calcom from "../dist/providers/calcom/_provider.js";
import googleCalendar from "../dist/providers/google_calendar/_provider.js";
import createGoogleBooking from "../dist/providers/google_calendar/create_booking.js";

afterEach(() => vi.unstubAllGlobals());

test("the browser catalog follows the registered providers", () => {
  expectTypeOf<IntegrationActionId>().not.toEqualTypeOf<string>();
  expectTypeOf<IntegrationProviderId>().not.toEqualTypeOf<string>();
  expectTypeOf<"calcom.create_booking">().toMatchTypeOf<IntegrationActionId>();
  expectTypeOf<"calcom">().toMatchTypeOf<IntegrationProviderId>();
  expect(browserActions).toEqual(integrationCatalog);
  expect(browserCatalog.map(({ icon, ...provider }) => provider)).toEqual(
    integrationProviderCatalog,
  );
});

test("dependencies follow provider configuration and default to none", () => {
  const calendar = { id: "calendar", title: "Calendar", timeZone: "UTC" };
  for (const provider of ["google_meet", "zoom"]) {
    expect(
      getIntegrationDependencies("google_calendar", {
        calendar,
        location: { type: "online", provider },
      }),
    ).toEqual([provider]);
  }
  for (const config of [
    { calendar },
    { calendar, location: { type: "none" } },
    { calendar, location: { type: "in_person", address: "Office" } },
    { calendar, location: { type: "online", provider: "unknown" } },
    {},
  ]) {
    expect(getIntegrationDependencies("google_calendar", config)).toEqual([]);
  }
  expect(getIntegrationDependencies("google_meet", {})).toEqual([]);
});

test("Cal.com connects without resource selection or rewriting tool parameters", async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(Response.json({ status: "success", data: { id: 123 } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    previewIntegration("calcom", { credentials: { apiKey: "secret" } }),
  ).resolves.toEqual({});
  await expect(
    configureIntegration("calcom", {
      credentials: { apiKey: " secret " },
      config: {},
    }),
  ).resolves.toEqual({ credentials: { apiKey: "secret" }, config: {} });
  await expect(
    configureIntegration("calcom", {
      credentials: { apiKey: "secret" },
      config: { calendar: { id: "123" } },
    }),
  ).rejects.toMatchObject({ code: "invalid_config" });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.cal.com/v2/me",
    expect.objectContaining({
      headers: { Authorization: "Bearer secret" },
      signal: expect.any(AbortSignal) as unknown,
    }),
  );
  expect(isIntegrationConfigured("calcom", {})).toBe(true);
  expect(isIntegrationConfigured("calcom", { eventTypes: [] })).toBe(false);
  expect(isIntegrationConfigured("google_calendar", {})).toBe(false);
  expect(isIntegrationConfigured("unknown", {})).toBe(false);
  expect(
    integrationTools("calcom").find(({ name }) => name === "create_booking")
      ?.args,
  ).toContainEqual({
    name: "event_type_id",
    type: "string",
    description: "Exact Cal.com event type ID.",
  });
  expect(integrationCatalog.map(({ actionId }) => actionId)).toContain(
    "google_calendar.create_booking",
  );
});

test.each([401, 403])(
  "Cal.com setup rejects invalid credentials (%s)",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(Response.json({ status: "error" }, { status })),
      ),
    );
    await expect(
      configureIntegration("calcom", {
        credentials: { apiKey: "invalid" },
        config: {},
      }),
    ).rejects.toMatchObject({ code: "provider_authentication_failed" });
  },
);

test.each(["list_slots", "list_bookings", "create_booking"])(
  "Cal.com %s requires and forwards the function's event type",
  async (name) => {
    const input =
      name === "create_booking"
        ? {
            start: "2026-09-05T09:00:00Z",
            attendee_name: "Ada",
            attendee_phone: "+31612345678",
            time_zone: "Europe/Amsterdam",
          }
        : name === "list_slots"
          ? {
              start: "2026-09-05T09:00:00Z",
              end: "2026-09-05T10:00:00Z",
              time_zone: "Europe/Amsterdam",
            }
          : {};
    const data =
      name === "list_slots"
        ? {
            "2026-09-05": [
              { start: "2026-09-05T09:00:00Z", end: "2026-09-05T09:30:00Z" },
            ],
          }
        : [{ uid: "booking" }];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data }))),
      );
    vi.stubGlobal("fetch", fetchMock);
    const context = { credentials: { apiKey: "secret" }, config: {} };
    await expect(
      execute(`calcom.${name}`, context, input),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const event_type_id of ["123", "456"]) {
      await execute(`calcom.${name}`, context, { ...input, event_type_id });
      const [url, request] = fetchMock.mock.calls.at(-1)!;
      if (name === "create_booking")
        expect(JSON.parse(request!.body as string) as unknown).toMatchObject({
          eventTypeId: Number(event_type_id),
        });
      else
        expect(
          new URL(url instanceof Request ? url.url : url).searchParams.get(
            "eventTypeId",
          ),
        ).toBe(event_type_id);
    }
  },
);

test.each(["cancel_booking", "reschedule_booking"])(
  "Cal.com %s acts directly on the supplied booking UID",
  async (name) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { uid: "booking" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    await execute(
      `calcom.${name}`,
      { credentials: { apiKey: "secret" }, config: {} },
      name === "cancel_booking"
        ? { booking_uid: "booking" }
        : { booking_uid: "booking", start: "2026-09-05T09:00:00Z" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toEqual([
      expect.stringContaining(
        `/bookings/booking/${name === "cancel_booking" ? "cancel" : "reschedule"}`,
      ),
      expect.objectContaining({ method: "POST" }),
    ]);
  },
);

test("credential forms derive names from schemas", () => {
  const provider = defineProvider({
    name: "Example",
    category: "automation",
    description: { en: "An example integration." },
    auth: {
      type: "api_key",
      schema: z.strictObject({
        token: z.string(),
        account: z.string(),
      }),
    },
    config: z.strictObject({}),
    response: () => Promise.resolve(null),
  });
  const runtime = createIntegrationRuntime({}, { example: provider });
  expect(runtime.getIntegrationSetup("example").credentials).toEqual([
    { name: "token", required: true, kind: "text", secret: true },
    { name: "account", required: true, kind: "text", secret: true },
  ]);
});

test("an unfamiliar provider generates resources, conditional settings, defaults and shared dependencies", () => {
  const provider = defineProvider({
    ...calcom,
    config: z.strictObject({
      workspace: z.strictObject({ id: z.string(), title: z.string() }),
      delivery: z
        .discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("local"),
            address: z.string().min(1).max(500),
          }),
          z.strictObject({
            kind: z.literal("remote"),
            service: z.enum(["example_meet"]).meta({ integration: true }),
          }),
        ])
        .default({ kind: "local", address: "Office" }),
      note: z.string().optional(),
    }),
    resources: {
      workspace: { list: () => Promise.resolve([]) },
    },
  });
  const runtime = createIntegrationRuntime({}, { unfamiliar: provider });
  const setup = runtime.getIntegrationSetup("unfamiliar");
  const workspace = { id: "one", title: "Office" };
  const config = setupDefaults(setup.config, { workspace });
  expect(config).toEqual({
    workspace,
    delivery: { kind: "local", address: "Office" },
  });
  expect(setup.config[0]).toEqual({
    name: "workspace",
    kind: "resource",
    required: true,
  });
  const remote = {
    workspace,
    delivery: { kind: "remote", service: "example_meet" },
  };
  expect(setupDependencies(setup.config, remote)).toEqual(
    runtime.getIntegrationDependencies("unfamiliar", remote),
  );
  expect(runtime.getIntegrationDependencies("unfamiliar", remote)).toEqual([
    "example_meet",
  ]);
  expect(setupDefaults(setup.config, remote)).toEqual(remote);
  expect(JSON.stringify(setup)).not.toMatch(
    /label|description|execute|authorizationUrl/u,
  );
});

test("legacy calendar settings keep their resource and gain schema defaults", () => {
  const runtime = createIntegrationRuntime({}, { calendar: googleCalendar });
  const fields = runtime.getIntegrationSetup("calendar").config;
  const calendar = { id: "one", title: "Work", timeZone: "UTC" };
  expect(setupDefaults(fields, { calendar })).toEqual({
    calendar,
    location: { type: "none" },
  });
  for (const location of [
    { type: "none" },
    { type: "in_person", address: "Office" },
    { type: "online", provider: "zoom" },
  ]) {
    const config = { calendar, location };
    expect(setupDefaults(fields, config)).toEqual(config);
    expect(runtime.isIntegrationConfigured("calendar", config)).toBe(true);
  }
});

test("email fields declare their domain resource without provider or config-name conventions", () => {
  const provider = defineProvider({
    ...calcom,
    config: z.strictObject({
      verifiedDomain: z
        .strictObject({ id: z.string(), title: z.string() })
        .nullable()
        .default(null),
      senderAddress: z.email().meta({ domainField: "verifiedDomain" }),
      note: z.string().default("Keep me"),
    }),
    resources: { verifiedDomain: { list: () => Promise.resolve([]) } },
  });
  const fields = createIntegrationRuntime(
    {},
    { unfamiliar: provider },
  ).getIntegrationSetup("unfamiliar").config;
  expect(fields[1]).toEqual({
    name: "senderAddress",
    kind: "email",
    domainField: "verifiedDomain",
    required: true,
  });
  const domain = { id: "domain", title: "example.com" };
  const config = {
    senderAddress: "hello@EXAMPLE.COM",
    verifiedDomain: { id: "stale", title: "old.example" },
  };
  expect(setupDefaults(fields, config, { verifiedDomain: [domain] })).toEqual({
    ...config,
    verifiedDomain: domain,
    note: "Keep me",
  });
  for (const resources of [[], null]) {
    expect(
      setupDefaults(fields, config, { verifiedDomain: resources }),
    ).toEqual({ ...config, verifiedDomain: null, note: "Keep me" });
  }
  expect(
    setupDefaults(
      fields,
      { senderAddress: "example.com" },
      { verifiedDomain: [domain] },
    ).verifiedDomain,
  ).toBeNull();
  expect(config.verifiedDomain.id).toBe("stale");
});

test.each(["missing", 1, null])(
  "invalid email domain metadata fails generation: %s",
  (domainField) => {
    expect(() =>
      createIntegrationRuntime(
        {},
        {
          unfamiliar: defineProvider({
            ...calcom,
            config: z.strictObject({ sender: z.email().meta({ domainField }) }),
          }),
        },
      ),
    ).toThrow("Invalid email domain field: sender");
  },
);

test.each([
  z.array(z.string()),
  z.number(),
  z.object({ name: z.string() }),
  z.object({ name: z.string() }).optional(),
  z.union([z.string(), z.boolean()]),
])(
  "unsupported setup shapes fail generation instead of silently hiding settings",
  (field) => {
    expect(() =>
      createIntegrationRuntime(
        {},
        {
          example: defineProvider({
            ...calcom,
            config: z.strictObject({ unsupported: field }),
          }),
        },
      ),
    ).toThrow("Unsupported integration setup field: unsupported");
  },
);

test("server validation identifies the submitted field without including its value", async () => {
  const runtime = createIntegrationRuntime(
    {},
    {
      example: defineProvider({
        ...calcom,
        verifyCredentials: async () => {},
        config: z.strictObject({ name: z.string().min(3) }),
      }),
    },
  );
  await expect(
    runtime.configureIntegration("example", {
      credentials: { apiKey: "secret" },
      config: { name: "x" },
    }),
  ).rejects.toMatchObject({ code: "invalid_config", fields: ["config.name"] });
});

test("provider metadata requires a category and nonempty language descriptions", () => {
  for (const description of [{}, { en: " " }, { "en-US": "Example" }]) {
    expect(() => defineProvider({ ...calcom, description })).toThrow();
  }
  expect(() =>
    // @ts-expect-error Providers must use one of the supported categories.
    defineProvider({ ...calcom, category: "unknown" }),
  ).toThrow();
});

test("resource fields follow the config schema and resolve optional and default selections", async () => {
  const room = { id: "room", title: "Meeting room" };
  const resource = z.strictObject({ id: z.string(), title: z.string() });
  const list = vi.fn(() => Promise.resolve([room]));
  const provider = defineProvider({
    ...calcom,
    verifyCredentials: async () => {},
    config: z.strictObject({
      room: resource.default(room),
      backup: resource.optional(),
    }),
    resources: {
      room: { list },
      backup: { list },
    },
  });
  const runtime = createIntegrationRuntime({}, { example: provider });
  expect(runtime.getIntegrationSetup("example").config).toEqual([
    { name: "room", kind: "resource", required: false, default: room },
    { name: "backup", kind: "resource", required: false },
  ]);
  await expect(
    runtime.configureIntegration("example", {
      credentials: { apiKey: "secret" },
      config: {},
    }),
  ).resolves.toMatchObject({ config: { room } });
  await expect(
    runtime.configureIntegration("example", {
      credentials: { apiKey: "secret" },
      config: { room, backup: { ...room, title: "Forged" } },
    }),
  ).resolves.toMatchObject({ config: { room, backup: room } });
  list.mockResolvedValue([]);
  await expect(
    runtime.configureIntegration("example", {
      credentials: { apiKey: "secret" },
      config: {},
    }),
  ).rejects.toMatchObject({ code: "resource_not_allowed" });
  list.mockResolvedValue([room, room]);
  await expect(
    runtime.previewIntegration("example", {
      credentials: { apiKey: "secret" },
    }),
  ).rejects.toMatchObject({ code: "invalid_provider_response" });
  expect(() =>
    defineProvider({
      ...provider,
      resources: {
        // @ts-expect-error Resource names must refer to config fields.
        missing: { list },
      },
    }),
  ).toThrow("Unknown integration resource config field: missing");
});

test("actions must use their registered provider", () => {
  expect(() =>
    createIntegrationRuntime(
      { "calcom.create_booking": createGoogleBooking },
      { calcom },
    ),
  ).toThrow("Invalid provider for integration action: calcom.create_booking");
});

test("auth modes infer credentials from their schema and reject mixed definitions", () => {
  expectTypeOf(calcom.auth.type).toEqualTypeOf<"api_key">();
  expectTypeOf(googleCalendar.auth.type).toEqualTypeOf<"oauth2">();
  expectTypeOf<
    typeof googleCalendar.auth.toCredentials
  >().returns.toEqualTypeOf<{
    accessToken: string;
  }>();
  expectTypeOf<{
    type: "api_key";
    schema: typeof calcom.auth.schema;
  }>().toMatchTypeOf<typeof calcom.auth>();
  expectTypeOf<{
    type: "oauth2";
    schema: typeof googleCalendar.auth.schema;
  }>().not.toMatchTypeOf<typeof googleCalendar.auth>();

  defineProvider({
    ...googleCalendar,
    auth: {
      ...googleCalendar.auth,
      // @ts-expect-error OAuth mappings must return every credential in the schema.
      toCredentials: () => ({}),
    },
  });
  defineProvider({
    ...googleCalendar,
    auth: {
      ...googleCalendar.auth,
      // @ts-expect-error Fields are derived, never declared separately.
      fields: [],
    },
  });
  defineProvider({
    ...calcom,
    auth: {
      ...calcom.auth,
      // @ts-expect-error API-key fields also come from schema metadata.
      fields: [],
    },
  });
});
