# @neuroline/integrations

Provider actions and OAuth helpers for AI agents. Node.js 22+, ESM.
To add an integration to this package, define a provider and its functions (actions).

`src/providers/example/_provider.ts`:

```ts
import { z } from "zod";
import { defineProvider, IntegrationError } from "../../core.ts";

export default defineProvider({
  name: "Example",
  category: "automation",
  description: { en: "Read items from Example." },
  auth: {
    type: "api_key",
    schema: z.strictObject({ apiKey: z.string().trim().min(1) }),
  },
  config: z.strictObject({}),
  async response(response) {
    if (!response.ok)
      throw new IntegrationError(
        "provider_error",
        `Request failed (${response.status})`,
      );
    return response.json();
  },
});
```

`src/providers/example/get_item.ts` (replace the example API URL):

```ts
import { z } from "zod";
import { defineAction } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description: "Get an item by ID.",
  input: z.strictObject({ id: z.string().min(1).describe("Item ID.") }),
  async execute({ credentials, input, signal }) {
    const response = await fetch(
      `https://api.example.com/items/${encodeURIComponent(input.id)}`,
      { headers: { Authorization: `Bearer ${credentials.apiKey}` }, signal },
    );
    return z
      .object({ id: z.string() })
      .parse(await provider.response(response));
  },
});
```

Add `_icon.svg` beside these files. From this package directory, run `npm run build`;
the build discovers and registers `example.get_item` automatically.
Prefix helper files with `_` so they are not treated as actions. Add tests beside
each action and run `npm test` after building.

## Development and releases

Use the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:package
```

Build first: the checks use generated exports in `dist/`. The package check
installs a tarball in a temporary consumer and checks both entry points and their
TypeScript declarations. CI runs these checks on Node 22 and 24.

For a change users should receive, run `pnpm exec changeset`, choose the version
bump, and commit the generated `.changeset/*.md` file with your PR. Documentation
and CI-only changes do not need a changeset.

After merging into `main`, the release workflow runs CI and then opens or updates
a **Version Packages** PR with the version and changelog. Merge that PR when ready
to publish. Once CI passes, Changesets publishes to npm and creates the Git tag
and GitHub Release. The existing `prepack` script builds the published files.
Re-run a failed release workflow after fixing its cause; already published
versions are skipped. Fix a bad release with a new version.

### Repository and npm setup

- In GitHub **Settings → Actions → General**, allow Actions to create and approve
  pull requests. Keep default workflow permissions read-only; the release job
  requests the write permissions it needs.
- Protect `main`: require pull requests and the `Check (Node 22)` and
  `Check (Node 24)` status checks. Keep the branch up to date before merging.
- Release PRs created with `GITHUB_TOKEN` may need **Approve workflows to run**
  before their required CI checks start.
- In the npm settings for `@neuroline/integrations`, configure a GitHub Actions
  trusted publisher: organization `neuroline-ai`, repository `integrations`,
  workflow filename `release.yml`, no environment, and allow direct `npm publish`.
  Complete the first automated publish within two days of creating the trust
  configuration. A package must already exist on npm before configuring trust.
- Publishing uses OIDC on a GitHub-hosted runner with Node 24 and npm 11.5.1 or
  newer. No `NPM_TOKEN` secret is needed. npm generates provenance for this public
  package and repository automatically.

This release flow follows [LiveKit's JavaScript SDK](https://github.com/livekit/client-sdk-js/blob/main/.github/workflows/release.yaml).
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for setup details.

Code: [Apache-2.0](LICENSE). Provider logos are excluded.
