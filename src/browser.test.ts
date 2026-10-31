import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import type * as Core from "../dist/core.js";
import calcom from "../dist/providers/calcom/_provider.js";
import googleCalendar from "../dist/providers/google_calendar/_provider.js";
import {
  getProviderDescription,
  integrationCatalog,
  integrationProviderCatalog,
  getIntegrationSetup,
} from "@neuroline/integrations/browser";

vi.mock("../dist/core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  createIntegrationRuntime: () => {
    throw new Error(
      "The browser catalog must not initialize the integration runtime",
    );
  },
}));

test("browser validation uses the original provider schemas, including normalization and refinements", () => {
  const credentials = getIntegrationSetup("calcom").definition.auth.schema;
  const config = getIntegrationSetup("google_calendar").definition.config;
  expect(credentials).toBe(calcom.auth.schema);
  expect(config).toBe(googleCalendar.config);
  expect(credentials.parse({ apiKey: `${" ".repeat(2048)}secret` })).toEqual({
    apiKey: "secret",
  });
  expect(credentials.safeParse({ apiKey: "   " }).success).toBe(false);
  const calendar = { id: "one", title: "Work", timeZone: "UTC" };
  expect(config.parse({ calendar })).toEqual({
    calendar,
    location: { type: "none" },
  });
  expect(
    config.safeParse({ calendar: { ...calendar, timeZone: "invalid" } }).error
      ?.issues[0]?.path,
  ).toEqual(["calendar", "timeZone"]);
});

test("descriptions use the requested language or the first defined language", () => {
  const provider = { description: { nl: "Nederlands", en: "English" } };
  expect(getProviderDescription(provider, "en")).toBe("English");
  for (const language of ["nl", "fr", "constructor", undefined]) {
    expect(getProviderDescription(provider, language)).toBe("Nederlands");
  }
  for (const provider of integrationProviderCatalog) {
    expect(
      Array.isArray(getIntegrationSetup(provider.provider).credentials),
    ).toBe(true);
    expect(Array.isArray(getIntegrationSetup(provider.provider).config)).toBe(
      true,
    );
    expect(getProviderDescription(provider, "fr")).toBe(
      Object.values(provider.description)[0],
    );
  }
});

test("unknown setup IDs cannot access inherited object properties", () => {
  expect(() => getIntegrationSetup("constructor")).toThrow(
    "Integration provider not found",
  );
});

test("the browser catalog loads independently and includes every provider's SVG", async () => {
  expect(integrationCatalog.length).toBeGreaterThan(0);
  for (const action of integrationCatalog) {
    expect(Object.keys(action).sort()).toEqual([
      "actionId",
      "args",
      "description",
      "provider",
    ]);
    expect(
      integrationProviderCatalog.some(
        ({ provider }) => provider === action.provider,
      ),
    ).toBe(true);
  }
  for (const provider of integrationProviderCatalog) {
    expect(provider.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(provider.icon.split(",")[1]!, "base64").toString()).toBe(
      await readFile(
        new URL(`./providers/${provider.provider}/_icon.svg`, import.meta.url),
        "utf8",
      ),
    );
  }
});
