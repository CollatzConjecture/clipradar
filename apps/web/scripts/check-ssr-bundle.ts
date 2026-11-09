// Nitro rebundles the server output but cannot see runtime `__require` calls,
// so any package loaded that way gets a second instance next to the bundled one.
// A second React broke every signed-in page (see commit 9d5b69f).
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";

const RUNTIME_REQUIRE = /__require\(["'](?<name>[^"']+)["']\)/gu;

const root = new URL("../.output/server", import.meta.url).pathname;
const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`])
);
const chunks = (await readdir(root, { recursive: true })).filter((entry) =>
  entry.endsWith(".mjs")
);
const sources = await Promise.all(
  chunks.map((entry) => readFile(join(root, entry), "utf8"))
);

const offenders = new Set<string>();
for (const [index, source] of sources.entries()) {
  for (const match of source.matchAll(RUNTIME_REQUIRE)) {
    const name = match.groups?.name;
    if (name && !builtins.has(name)) {
      offenders.add(`${name} in ${chunks[index]}`);
    }
  }
}

if (offenders.size > 0) {
  console.error(
    `Runtime require of bundled packages in .output/server:\n${[...offenders].join("\n")}`
  );
  process.exit(1);
}
