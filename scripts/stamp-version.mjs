import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Inlines the package version into dist/userAgent.js (see BUILD_VERSION).
const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const target = path.join(root, "dist", "userAgent.js");
const source = await readFile(target, "utf8");
const placeholder = 'const BUILD_VERSION = "__SDK_VERSION__";';
const stamped = `const BUILD_VERSION = ${JSON.stringify(version)};`;
const occurrences = source.split(placeholder).length - 1;
if (occurrences === 0 && source.includes(stamped)) process.exit(0);
if (occurrences !== 1) {
  const current = /const BUILD_VERSION = ("[^"]*");/.exec(source)?.[1];
  throw new Error(
    current
      ? `${target} is stamped with ${current}, expected ${JSON.stringify(version)}; run pnpm build.`
      : `Expected one \`${placeholder}\` line in ${target}; run pnpm build.`,
  );
}
await writeFile(target, source.replace(placeholder, stamped));
