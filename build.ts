import { glob, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  createIntegrationRuntime,
  type defineAction,
  type defineProvider,
} from "./src/core.ts";

const root = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(root, "src");
const providersRoot = resolve(sourceRoot, "providers");
const actionIdPattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;
const providerIdPattern = /^[a-z][a-z0-9_]*$/u;
const providers = [];
for await (const sourcePath of glob("*/_provider.ts", {
  cwd: providersRoot,
})) {
  const provider = dirname(sourcePath);
  if (!providerIdPattern.test(provider)) {
    throw new Error(`Invalid integration provider ID: ${provider}`);
  }
  const { default: definition } = (await import(
    pathToFileURL(resolve(providersRoot, sourcePath)).href
  )) as { default: ReturnType<typeof defineProvider> };
  providers.push({ provider, sourcePath, definition });
}
providers.sort((left, right) => left.provider.localeCompare(right.provider));

const actionFiles: string[] = [];
for await (const sourcePath of glob("*/*.ts", { cwd: providersRoot })) {
  if (
    !sourcePath.split("/").some((part) => part.startsWith("_")) &&
    !/\.(?:test|spec)\.ts$/u.test(sourcePath)
  ) {
    actionFiles.push(sourcePath);
  }
}
const actions = await Promise.all(
  actionFiles.sort().map(async (sourcePath, index) => {
    const actionId = sourcePath.replace(/\.ts$/u, "").replace("/", ".");
    if (!actionIdPattern.test(actionId)) {
      throw new Error(`Invalid integration action ID: ${actionId}`);
    }
    const { default: definition } = (await import(
      pathToFileURL(resolve(providersRoot, sourcePath)).href
    )) as { default: ReturnType<typeof defineAction> };
    return { actionId, importName: `action${index}`, sourcePath, definition };
  }),
);

const providerIds = new Set(providers.map(({ provider }) => provider));
for (const { actionId } of actions) {
  const provider = actionId.split(".")[0]!;
  if (!providerIds.has(provider)) {
    throw new Error(`Missing provider definition: ${provider}`);
  }
}

const registrySource = `import { createIntegrationRuntime } from "./core.ts";
${providers
  .map(
    ({ sourcePath }, index) =>
      `import provider${index} from "./providers/${sourcePath}";`,
  )
  .join("\n")}
${actions
  .map(
    ({ importName, sourcePath }) =>
      `import ${importName} from "./providers/${sourcePath}";`,
  )
  .join("\n")}

const registry = {
${actions.map(({ actionId, importName }) => `  "${actionId}": ${importName},`).join("\n")}
} as const;

const providerRegistry = {
${providers.map(({ provider }, index) => `  ${provider}: provider${index},`).join("\n")}
} as const;

export type IntegrationActionId = keyof typeof registry;
export type IntegrationProviderId = keyof typeof providerRegistry;

export const {
  getIntegrationAuth,
  getIntegrationSetup,
  getIntegrationDependencies,
  integrationEnvironmentVariables,
  isIntegrationConfigured,
  configureIntegration,
  execute,
  integrationCatalog,
  integrationProviderCatalog,
  integrationTools,
  previewIntegration,
} = createIntegrationRuntime(registry, providerRegistry);

export {
  defineAction,
  IntegrationError,
  defineProvider,
  integrationCategories,
  getProviderDescription,
} from "./core.ts";
export type {
  IntegrationCategory,
  SendSms,
  ExecuteIntegration,
  IntegrationAuth,
  IntegrationResource,
} from "./core.ts";
export { oauthAuthorizationUrl, exchangeOAuthTokens, oauthTokensSchema } from "./oauth.ts";
export type { OAuthDefinition, OAuthTokens } from "./oauth.ts";
`;

const definitions = Object.fromEntries(
  providers.map(({ provider, definition }) => [provider, definition]),
);
const { integrationCatalog, integrationProviderCatalog, getIntegrationSetup } =
  createIntegrationRuntime(
    Object.fromEntries(
      actions.map(({ actionId, definition }) => [actionId, definition]),
    ),
    definitions,
  );
const browserCatalog = await Promise.all(
  integrationProviderCatalog.map(async (provider) => ({
    ...provider,
    // Inline the small SVGs so the catalog needs no framework-specific loader.
    icon: `data:image/svg+xml;base64,${(
      await readFile(resolve(providersRoot, provider.provider, "_icon.svg"))
    ).toString("base64")}`,
  })),
);
const browserSource = `import type { createIntegrationRuntime, defineProvider } from "./core.ts";
import type { IntegrationSetup } from "./core.ts";
${providers.map(({ sourcePath }, index) => `import provider${index} from "./providers/${sourcePath}";`).join("\n")}

const providerDefinitions: Record<string, ReturnType<typeof defineProvider>> = {
${providers.map(({ provider }, index) => `  ${provider}: provider${index},`).join("\n")}
};

export type IntegrationProvider = ReturnType<typeof createIntegrationRuntime>["integrationProviderCatalog"][number] & {
  icon: string;
};

export const integrationProviderCatalog: IntegrationProvider[] = ${JSON.stringify(browserCatalog, null, 2)};

export type IntegrationAction = ReturnType<typeof createIntegrationRuntime>["integrationCatalog"][number];
export const integrationCatalog: IntegrationAction[] = ${JSON.stringify(integrationCatalog, null, 2)};

const integrationSetups: Record<string, IntegrationSetup> = ${JSON.stringify(Object.fromEntries(providers.map(({ provider }) => [provider, getIntegrationSetup(provider)])), null, 2)};

export function getIntegrationSetup(provider: string) {
  if (!Object.hasOwn(integrationSetups, provider)) throw new Error("Integration provider not found");
  return { ...integrationSetups[provider]!, definition: providerDefinitions[provider]! };
}

export { integrationCategories, getProviderDescription, setupDefaults, setupRecord } from "./core.ts";
export type { IntegrationCategory, IntegrationField, IntegrationSetup, IntegrationResource } from "./core.ts";
`;

const configFile = ts.readConfigFile(
  resolve(root, "tsconfig.build.json"),
  (fileName) => ts.sys.readFile(fileName),
);
if (configFile.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
  );
}
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const entries = new Map([
  [resolve(sourceRoot, "index.ts"), registrySource],
  [resolve(sourceRoot, "browser.ts"), browserSource],
]);
const host = ts.createCompilerHost(config.options);
const readSource = host.readFile.bind(host);
const sourceExists = host.fileExists.bind(host);
// Compile generated entry points in memory so builds only write to dist/.
host.readFile = (fileName) => entries.get(fileName) ?? readSource(fileName);
host.fileExists = (fileName) => entries.has(fileName) || sourceExists(fileName);
const program = ts.createProgram({
  rootNames: [...config.fileNames, ...entries.keys()],
  options: config.options,
  host,
  configFileParsingDiagnostics: config.errors,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  throw new Error(ts.formatDiagnostics(diagnostics, host));
}
await rm(resolve(root, "dist"), { recursive: true, force: true });
const result = program.emit();
if (result.emitSkipped || result.diagnostics.length) {
  throw new Error(
    ts.formatDiagnostics(result.diagnostics, host) || "Build failed",
  );
}
