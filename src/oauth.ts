import { z } from "zod";
import { IntegrationError } from "./core.ts";

export type OAuthDefinition<
  Credentials extends z.ZodObject<Record<string, z.ZodString>> = z.ZodObject<
    Record<string, z.ZodString>
  >,
> = {
  type: "oauth2";
  schema: Credentials;
  clientIdEnv: string;
  clientSecretEnv: string;
  authorizationUrl: string;
  tokenUrl: string;
  tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic";
  scopes: string[];
  authorizationParams?: Record<string, string>;
  toCredentials(tokens: OAuthTokens): z.output<NoInfer<Credentials>>;
};
export type OAuthTokens = z.output<typeof oauthTokensSchema>;

export const oauthTokensSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384),
  expiresAt: z.number().finite().positive(),
  scopes: z.array(z.string().min(1).max(500)).max(100),
});

export function oauthAuthorizationUrl(
  auth: OAuthDefinition,
  context: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
  },
) {
  const url = new URL(auth.authorizationUrl);
  url.search = new URLSearchParams({
    ...auth.authorizationParams,
    response_type: "code",
    client_id: context.clientId,
    redirect_uri: context.redirectUri,
    state: context.state,
    scope: auth.scopes.join(" "),
    code_challenge: context.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeOAuthTokens(
  auth: OAuthDefinition,
  context: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    grant: { code: string; verifier: string } | { tokens: OAuthTokens };
    signal: AbortSignal;
  },
): Promise<OAuthTokens> {
  const previous = "tokens" in context.grant ? context.grant.tokens : undefined;
  const basicAuth = auth.tokenEndpointAuthMethod === "client_secret_basic";
  const response = await fetch(auth.tokenUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(basicAuth
        ? {
            Authorization: `Basic ${btoa(`${context.clientId}:${context.clientSecret}`)}`,
          }
        : {}),
    },
    body: new URLSearchParams({
      ...(!basicAuth
        ? { client_id: context.clientId, client_secret: context.clientSecret }
        : {}),
      redirect_uri: context.redirectUri,
      ...("code" in context.grant
        ? {
            grant_type: "authorization_code",
            code: context.grant.code,
            code_verifier: context.grant.verifier,
          }
        : {
            grant_type: "refresh_token",
            refresh_token: context.grant.tokens.refreshToken,
          }),
    }),
    signal: context.signal,
  });
  const value: unknown = await response.json().catch(() => null);
  const payload = z.record(z.string(), z.unknown()).safeParse(value);
  if (!payload.success) {
    throw new IntegrationError(
      "invalid_provider_response",
      "Provider returned an invalid token response",
    );
  }
  const data = payload.data;
  if (!response.ok || data.error) {
    const revoked =
      previous &&
      (data.error === "invalid_grant" || data.error === "invalid_code");
    throw new IntegrationError(
      revoked ? "oauth_reconnect_required" : "oauth_refresh_failed",
      revoked
        ? "Reconnect this integration to restore access"
        : "Could not obtain provider credentials",
    );
  }
  const scopes =
    typeof data.scope === "string"
      ? data.scope.split(/[\s,]+/u).filter(Boolean)
      : (previous?.scopes ?? auth.scopes);
  // offline_access grants a refresh token, not an access-token permission.
  if (
    !auth.scopes.every(
      (scope) => scope === "offline_access" || scopes.includes(scope),
    )
  ) {
    throw new IntegrationError(
      "oauth_reconnect_required",
      "Grant the required permissions when reconnecting this integration",
    );
  }
  const expiresIn = z.coerce
    .number()
    .finite()
    .positive()
    .max(31_536_000)
    .safeParse(data.expires_in);
  if (!expiresIn.success) {
    throw new IntegrationError(
      "invalid_provider_response",
      "Provider returned an invalid token expiry",
    );
  }
  if (
    data.token_type !== undefined &&
    (typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer")
  ) {
    throw new IntegrationError(
      "invalid_provider_response",
      "Provider returned an unsupported token type",
    );
  }
  if (!previous && !data.refresh_token) {
    throw new IntegrationError(
      "oauth_reconnect_required",
      "Reconnect this integration and allow offline access",
    );
  }
  const tokens = oauthTokensSchema.safeParse({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + expiresIn.data * 1_000,
    scopes,
  });
  if (!tokens.success) {
    throw new IntegrationError(
      "invalid_provider_response",
      "Provider returned invalid credentials",
    );
  }
  return tokens.data;
}
