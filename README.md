# @neuroline/integrations

Provider actions and OAuth helpers for AI agents. Node.js 24+, ESM.
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

Add `_icon.svg` beside these files. From this package directory, run `pnpm build`;
the build discovers and registers `example.get_item` automatically.
Prefix helper files with `_` so they are not treated as actions. Add tests beside
each action.

Code: [Apache-2.0](LICENSE). Provider logos are excluded.
