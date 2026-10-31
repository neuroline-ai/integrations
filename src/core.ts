import { z } from "zod";
import type { OAuthDefinition } from "./oauth.ts";
export const integrationCategories = [
  "management",
  "communication",
  "knowledge",
  "automation",
] as const;

export type IntegrationCategory = (typeof integrationCategories)[number];

export function getProviderDescription(
  provider: { description: Record<string, string> },
  language?: string,
): string {
  // The first language in _provider.ts is the default; preserve entry order.
  return language && Object.hasOwn(provider.description, language)
    ? provider.description[language]!
    : Object.values(provider.description)[0]!;
}

export type SendSms = (args: { to: string; message: string }) => Promise<{
  ok: boolean;
  result?: unknown;
  error?: string;
}>;
export type ExecuteIntegration = (
  actionId: string,
  input: unknown,
) => Promise<unknown>;

export type IntegrationActionArgument = {
  name: string;
  type: "any" | "boolean" | "integer" | "number" | "string";
  description: string;
};

function actionArguments(input: z.ZodObject): IntegrationActionArgument[] {
  return Object.entries(input.shape as Record<string, z.ZodType>).map(
    ([name, schema]) => {
      const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
      const type =
        schema.type === "any" || schema.type === "unknown" ? "any" : json.type;
      if (
        typeof type !== "string" ||
        !["any", "boolean", "integer", "number", "string"].includes(type) ||
        typeof json.description !== "string"
      ) {
        throw new Error(`Invalid integration action argument: ${name}`);
      }
      return {
        name,
        type: type as IntegrationActionArgument["type"],
        description: json.description,
      };
    },
  );
}

export function defineAction<
  Credentials extends z.ZodType,
  Config extends z.ZodType,
  Input extends z.ZodObject,
  Output,
>(
  provider: { auth: { schema: Credentials }; config: Config },
  action: {
    description: string;
    input: Input;
    execute(context: {
      credentials: z.output<Credentials>;
      config: z.output<Config>;
      input: z.output<Input>;
      signal: AbortSignal;
      sendSms?: SendSms | undefined;
      execute?: ExecuteIntegration | undefined;
    }): Promise<Output>;
  },
) {
  return {
    ...action,
    provider,
    args: actionArguments(action.input),
  };
}

export class IntegrationError extends Error {
  readonly code: string;
  readonly fields: string[];

  constructor(code: string, message: string, fields: string[] = []) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.fields = fields;
  }
}

const resourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  timeZone: z.string().optional(),
});
export type IntegrationResource = z.output<typeof resourceSchema>;
const resourcesSchema = z
  .array(resourceSchema)
  .refine(
    (resources) =>
      new Set(resources.map(({ id }) => id)).size === resources.length,
  )
  .nullable();

type CredentialSchema = z.ZodObject<Record<string, z.ZodString>>;

export type IntegrationAuth<
  Credentials extends CredentialSchema = CredentialSchema,
> =
  | {
      type: "api_key";
      schema: Credentials;
    }
  | OAuthDefinition<Credentials>;

export function defineProvider<
  Credentials extends CredentialSchema,
  Config extends z.ZodObject<Record<string, z.ZodType>>,
  Mode extends IntegrationAuth["type"],
>(provider: {
  name: string;
  category: IntegrationCategory;
  description: Record<string, string>;
  auth: IntegrationAuth<Credentials> & { type: Mode };
  config: Config;
  verifyCredentials?(context: {
    credentials: z.output<Credentials>;
    signal: AbortSignal;
    response: (response: Response) => Promise<unknown>;
  }): Promise<void>;
  resources?: {
    [Field in keyof z.output<Config>]?: {
      // null means this credential cannot list resources; [] means none exist.
      list(context: {
        credentials: z.output<Credentials>;
        signal: AbortSignal;
        response: (response: Response) => Promise<unknown>;
      }): Promise<IntegrationResource[] | null>;
    };
  };
  response: (response: Response) => Promise<unknown>;
}) {
  z.enum(integrationCategories).parse(provider.category);
  z.record(z.string().regex(/^[a-z]{2,3}$/u), z.string().trim().min(1))
    .refine((description) => Object.keys(description).length > 0)
    .parse(provider.description);
  for (const field of Object.keys(provider.resources ?? {})) {
    if (!Object.hasOwn(provider.config.shape, field))
      throw new Error(`Unknown integration resource config field: ${field}`);
  }
  return provider;
}

export function createIntegrationRuntime(
  registry: Record<string, ReturnType<typeof defineAction>>,
  providerRegistry: Record<string, ReturnType<typeof defineProvider>>,
) {
  const integrationCatalog = Object.entries(registry).map(
    ([actionId, action]) => {
      const provider = actionId.split(".")[0]!;
      if (action.provider !== providerRegistry[provider]) {
        throw new Error(`Invalid provider for integration action: ${actionId}`);
      }
      return {
        actionId,
        provider,
        description: action.description,
        args: action.args,
      };
    },
  );

  const integrationProviderCatalog = Object.entries(providerRegistry).map(
    ([provider, definition]) => ({
      provider,
      name: definition.name,
      category: definition.category,
      description: definition.description,
      authType: definition.auth.type,
    }),
  );

  const integrationSetups = Object.fromEntries(
    Object.entries(providerRegistry).map(([provider, definition]) => [
      provider,
      {
        credentials:
          definition.auth.type === "api_key"
            ? setupFields(definition.auth.schema, {}, true)
            : [],
        config: setupFields(definition.config, definition.resources),
      },
    ]),
  );

  function getProvider(provider: string) {
    const definition = providerRegistry[provider];
    if (!definition) {
      throw new IntegrationError(
        "provider_not_found",
        "Integration provider not found",
      );
    }
    return definition;
  }

  function parse<Schema extends z.ZodType>(
    schema: Schema,
    value: unknown,
    kind: "credentials" | "config" | "input",
  ): z.output<Schema> {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new IntegrationError(
        `invalid_${kind}`,
        `Invalid integration ${kind}`,
        result.error.issues.map((issue) => [kind, ...issue.path].join(".")),
      );
    return result.data;
  }

  async function loadProvider(
    provider: string,
    credentials: unknown,
    signal?: AbortSignal,
  ) {
    const definition = getProvider(provider);
    const parsedCredentials = parse(
      definition.auth.schema,
      credentials,
      "credentials",
    );
    try {
      await definition.verifyCredentials?.({
        credentials: parsedCredentials,
        signal: signal ?? new AbortController().signal,
        response: definition.response,
      });
      const resources = Object.fromEntries(
        await Promise.all(
          Object.entries(definition.resources ?? {}).map(
            async ([field, resource]) => {
              const choices = await resource!.list({
                credentials: parsedCredentials,
                signal: signal ?? new AbortController().signal,
                response: definition.response,
              });
              if (!resourcesSchema.safeParse(choices).success) {
                throw new IntegrationError(
                  "invalid_provider_response",
                  "Integration provider returned invalid resources",
                );
              }
              return [field, choices] as const;
            },
          ),
        ),
      );
      return { definition, credentials: parsedCredentials, resources };
    } catch (error) {
      throw error instanceof IntegrationError
        ? error
        : new IntegrationError(
            "integration_failed",
            "Integration setup failed",
          );
    }
  }

  async function previewIntegration(
    provider: string,
    context: { credentials: unknown; signal?: AbortSignal },
  ) {
    return (await loadProvider(provider, context.credentials, context.signal))
      .resources;
  }

  async function configureIntegration(
    provider: string,
    context: {
      credentials: unknown;
      config: unknown;
      signal?: AbortSignal;
    },
  ) {
    const setup = await loadProvider(
      provider,
      context.credentials,
      context.signal,
    );
    const config = parse(setup.definition.config, context.config, "config");
    for (const [field, choices] of Object.entries(setup.resources)) {
      if (config[field] === undefined) continue;
      if (choices === null && config[field] === null) continue;
      const { id } = parse(
        resourceSchema.pick({ id: true }),
        config[field],
        "config",
      );
      const resource = choices?.find((candidate) => candidate.id === id);
      if (!resource) {
        throw new IntegrationError(
          "resource_not_allowed",
          "Integration resource is unavailable",
          [`config.${field}`],
        );
      }
      // Resource metadata comes from the provider, never from the submitted form.
      config[field] = resource;
    }

    return {
      credentials: setup.credentials,
      config: parse(setup.definition.config, config, "config"),
    };
  }

  function integrationTools(provider: string) {
    return integrationCatalog
      .filter((action) => action.provider === provider)
      .map((action) => ({
        actionId: action.actionId,
        name: action.actionId.split(".")[1]!,
        description: action.description,
        args: action.args,
      }));
  }

  async function execute(
    actionId: string,
    context: {
      credentials: unknown;
      config: unknown;
      signal?: AbortSignal;
      sendSms?: SendSms | undefined;
      execute?: ExecuteIntegration | undefined;
    },
    input: unknown,
  ): Promise<unknown> {
    const action = registry[actionId];
    if (!action) {
      throw new IntegrationError(
        "action_not_found",
        "Integration action not found",
      );
    }

    const credentials = parse(
      action.provider.auth.schema,
      context.credentials,
      "credentials",
    );
    const config = parse(action.provider.config, context.config, "config");
    const parsedInput = parse(action.input, input, "input");
    return action.execute({
      credentials,
      config,
      input: parsedInput,
      signal: context.signal ?? new AbortController().signal,
      sendSms: context.sendSms,
      execute: context.execute,
    });
  }

  return {
    getIntegrationDependencies: (provider: string, config: unknown) => {
      const definition = getProvider(provider);
      const parsed = definition.config.safeParse(config);
      return parsed.success
        ? setupDependencies(integrationSetups[provider]!.config, parsed.data)
        : [];
    },
    isIntegrationConfigured: (
      provider: string,
      config: unknown,
    ): config is Record<string, unknown> =>
      providerRegistry[provider]?.config.safeParse(config).success === true,
    integrationEnvironmentVariables: Object.values(providerRegistry).flatMap(
      ({ auth }) =>
        auth.type === "oauth2" ? [auth.clientIdEnv, auth.clientSecretEnv] : [],
    ),
    getIntegrationAuth: (provider: string) => getProvider(provider).auth,
    getIntegrationSetup: (provider: string) => {
      getProvider(provider);
      return integrationSetups[provider]!;
    },
    configureIntegration,
    execute,
    integrationCatalog,
    integrationProviderCatalog,
    integrationTools,
    previewIntegration,
  };
}

type FieldBase = {
  name: string;
  required: boolean;
  default?: unknown;
};

export type IntegrationField = FieldBase &
  (
    | { kind: "text"; secret: boolean }
    | { kind: "email"; domainField: string }
    | { kind: "choice"; options: { value: string }[]; integration: boolean }
    | {
        kind: "union";
        discriminator: string;
        options: { value: string; fields: IntegrationField[] }[];
      }
    | { kind: "resource" }
  );

export type IntegrationSetup = {
  credentials: IntegrationField[];
  config: IntegrationField[];
};

export function setupRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function setupDefaults(
  fields: IntegrationField[],
  value: unknown = {},
  resources?: Record<string, IntegrationResource[] | null>,
): Record<string, unknown> {
  const result = { ...setupRecord(value) };
  for (const field of fields) {
    if (result[field.name] === undefined && field.default !== undefined)
      result[field.name] = structuredClone(field.default);
    if (field.kind === "email" && resources) {
      const address = result[field.name];
      const domain =
        typeof address === "string" && address.includes("@")
          ? address
              .slice(address.lastIndexOf("@") + 1)
              .trim()
              .toLowerCase()
          : "";
      result[field.domainField] =
        resources[field.domainField]?.find(({ title }) => title === domain) ??
        null;
    }
    if (field.kind === "union") {
      const current = setupRecord(result[field.name]);
      const branch = field.options.find(
        (option) => option.value === current[field.discriminator],
      );
      if (branch) result[field.name] = setupDefaults(branch.fields, current);
    }
  }
  return result;
}

export function setupDependencies(
  fields: IntegrationField[],
  value: unknown,
): string[] {
  const record = setupRecord(value);
  return [
    ...new Set(
      fields.flatMap((field) => {
        const current = record[field.name];
        if (
          field.kind === "choice" &&
          field.integration &&
          typeof current === "string"
        )
          return field.options.some((option) => option.value === current)
            ? [current]
            : [];
        if (field.kind === "union") {
          const branch = field.options.find(
            (option) =>
              option.value === setupRecord(current)[field.discriminator],
          );
          return branch ? setupDependencies(branch.fields, current) : [];
        }
        return [];
      }),
    ),
  ];
}

type Schema = z.core.JSONSchema.JSONSchema;

function setupFields(
  schema: z.ZodObject,
  resources: Record<string, unknown> = {},
  credentials = false,
): IntegrationField[] {
  const json = z.toJSONSchema(schema, { io: "input" });
  function fields(object: Schema, path = ""): IntegrationField[] {
    return Object.entries(object.properties ?? {}).map(([name, definition]) =>
      field(
        name,
        definition,
        object.required?.includes(name) ?? false,
        path ? `${path}.${name}` : name,
      ),
    );
  }
  function field(
    name: string,
    definition: Schema | boolean,
    required: boolean,
    path: string,
  ): IntegrationField {
    if (typeof definition === "boolean")
      throw new Error(`Unsupported integration setup field: ${path}`);
    if (definition.const !== undefined || definition.$ref || definition.allOf)
      throw new Error(`Unsupported integration setup field: ${path}`);
    const base = {
      name,
      required,
      ...(definition.default !== undefined
        ? { default: definition.default }
        : {}),
    };
    if (resources[path]) return { ...base, kind: "resource" };
    if (definition.domainField !== undefined) {
      if (
        credentials ||
        definition.type !== "string" ||
        typeof definition.domainField !== "string" ||
        !Object.hasOwn(resources, definition.domainField)
      )
        throw new Error(`Invalid email domain field: ${path}`);
      return { ...base, kind: "email", domainField: definition.domainField };
    }
    if (
      definition.type === "string" &&
      definition.enum?.every((value) => typeof value === "string")
    ) {
      return {
        ...base,
        kind: "choice",
        integration: definition.integration === true,
        options: definition.enum.map((value) => ({ value })),
      };
    }
    if (definition.integration === true)
      throw new Error(`Integration references must be string enums: ${path}`);
    if (definition.type === "string")
      return { ...base, kind: "text", secret: credentials };
    if (definition.oneOf ?? definition.anyOf) {
      const branches = (definition.oneOf ?? definition.anyOf)!;
      const discriminator = Object.keys(branches[0]?.properties ?? {}).find(
        (key) => {
          const values = branches.map((branch) => {
            const property = branch.properties?.[key];
            return property && typeof property === "object"
              ? property.const
              : undefined;
          });
          return (
            values.every((value) => typeof value === "string") &&
            new Set(values).size === branches.length
          );
        },
      );
      if (
        discriminator &&
        branches.every(
          (branch) =>
            branch.type === "object" &&
            branch.required?.includes(discriminator),
        )
      ) {
        return {
          ...base,
          kind: "union",
          discriminator,
          options: branches.map((branch) => {
            const value = (branch.properties![discriminator] as Schema)
              .const as string;
            return {
              value,
              fields: fields(
                {
                  ...branch,
                  properties: Object.fromEntries(
                    Object.entries(branch.properties!).filter(
                      ([key]) => key !== discriminator,
                    ),
                  ),
                },
                path,
              ),
            };
          }),
        };
      }
    }
    throw new Error(
      `Unsupported integration setup field: ${path}. Use text, string enums, discriminated unions, or a resource.`,
    );
  }
  return fields(json);
}
