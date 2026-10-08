import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Writes the package version into dist, so the agent User-Agent carries it even once the SDK is
// bundled or compiled into a single executable without its package.json.
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
