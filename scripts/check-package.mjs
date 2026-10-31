import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const consumer = mkdtempSync(join(tmpdir(), "integrations-package-"));

try {
  const [{ filename, files }] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", consumer],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const entry of Object.values(pkg.exports)) {
    for (const path of Object.values(entry)) {
      assert(files.some((file) => file.path === path.slice(2)), `Missing ${path}`);
    }
  }
  assert(!files.some((file) => /\.(test|spec)\.ts$/.test(file.path)));

  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(consumer, filename),
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import * as server from "@neuroline/integrations";
    import * as browser from "@neuroline/integrations/browser";
    assert.equal(typeof server.execute, "function");
    assert.equal(typeof browser.getIntegrationSetup, "function");
    assert(server.integrationCatalog.length > 0);
    assert.equal(server.integrationCatalog.length, browser.integrationCatalog.length);
  `], { cwd: consumer, stdio: "inherit" });

  writeFileSync(join(consumer, "index.mts"), `
    import "@neuroline/integrations";
    import "@neuroline/integrations/browser";
  `);
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2022",
      "index.mts",
    ],
    { cwd: consumer, stdio: "inherit" },
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
