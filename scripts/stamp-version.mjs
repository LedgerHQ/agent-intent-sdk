import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Inlines the package version into dist/userAgent.js (see BUILD_VERSION).
const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const target = path.join(root, "dist", "userAgent.js");
const source = await readFile(target, "utf8");
const placeholder = '"__SDK_VERSION__"';
const stamped = `const BUILD_VERSION = ${JSON.stringify(version)};`;
const occurrences = source.split(placeholder).length - 1;
if (occurrences === 0 && source.includes(stamped)) process.exit(0);
if (occurrences !== 1) {
  throw new Error(`Expected one ${placeholder} in ${target}.`);
}
await writeFile(target, source.replace(placeholder, JSON.stringify(version)));
