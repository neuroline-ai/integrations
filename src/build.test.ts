import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type * as Integrations from "@neuroline/integrations";
import type * as Browser from "@neuroline/integrations/browser";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("build discovers new integrations without writing source files and rejects type errors", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "integrations-build-"));
  try {
    for (const name of [
      "src",
      "build.ts",
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
    ]) {
      await cp(join(root, name), join(fixture, name), { recursive: true });
    }
    await symlink(
      join(root, "node_modules"),
      join(fixture, "node_modules"),
      "junction",
    );
    const provider = join(fixture, "src/providers/example");
    await mkdir(provider);
    await writeFile(
      join(provider, "_provider.ts"),
      'export { default } from "../calcom/_provider.ts";',
    );
    const action = 'export { default } from "../calcom/list_bookings.ts";';
    await writeFile(join(provider, "list_bookings.ts"), action);
    await cp(
      join(root, "src/providers/calcom/_icon.svg"),
      join(provider, "_icon.svg"),
    );
    const sources = await readdir(join(fixture, "src"), { recursive: true });

    await exec(process.execPath, ["--experimental-strip-types", "build.ts"], {
      cwd: fixture,
    });
    const server = (await import(
      pathToFileURL(join(fixture, "dist/index.js")).href
    )) as typeof Integrations;
    const browser = (await import(
      pathToFileURL(join(fixture, "dist/browser.js")).href
    )) as typeof Browser;
    expect(server.integrationCatalog).toContainEqual(
      expect.objectContaining({
        actionId: "example.list_bookings",
        provider: "example",
      }),
    );
    expect(browser.integrationProviderCatalog).toContainEqual(
      expect.objectContaining({
        provider: "example",
        icon: expect.stringMatching(/^data:image\/svg\+xml;base64,/) as unknown,
      }),
    );
    expect(await readdir(join(fixture, "src"), { recursive: true })).toEqual(
      sources,
    );

    await writeFile(
      join(provider, "list_bookings.ts"),
      `${action}\nconst invalid: string = 1; void invalid;`,
    );
    await expect(
      exec(process.execPath, ["--experimental-strip-types", "build.ts"], {
        cwd: fixture,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "not assignable to type 'string'",
      ) as unknown,
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
