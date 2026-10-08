import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const packDirectory = await mkdtemp(path.join(tmpdir(), "agent-intent-sdk-pack-"));
const consumerDirectory = await mkdtemp(path.join(tmpdir(), "agent-intent-sdk-consumer-"));

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

try {
  run("pnpm", ["pack", "--pack-destination", packDirectory], root);
  const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one tarball, found ${tarballs.length}.`);
  }

  const tarball = path.join(packDirectory, tarballs[0]);
  const entries = run("tar", ["-tf", tarball], root).split("\n");
  for (const required of [
    "package/package.json",
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    if (!entries.includes(required)) throw new Error(`Package is missing ${required}.`);
  }
  if (entries.some((entry) => entry.startsWith("package/src/"))) {
    throw new Error("Package unexpectedly contains TypeScript source files.");
  }

  await writeFile(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run("pnpm", ["add", "--ignore-workspace", tarball], consumerDirectory);
  await writeFile(
    path.join(consumerDirectory, "smoke.mjs"),
    'import { createNonce } from "@ledgerhq/agent-intent-sdk";\n' +
      'if (!/^[0-9a-f]{32}$/.test(createNonce())) throw new Error("SDK smoke test failed.");\n',
  );
  run("node", ["smoke.mjs"], consumerDirectory);

  const manifest = JSON.parse(
    await readFile(
      path.join(consumerDirectory, "node_modules/@ledgerhq/agent-intent-sdk/package.json"),
    ),
  );
  if (manifest.private === true) throw new Error("Packed package must not be private.");
  const userAgentModule = await readFile(
    path.join(consumerDirectory, "node_modules/@ledgerhq/agent-intent-sdk/dist/userAgent.js"),
    "utf8",
  );
  if (!userAgentModule.includes(JSON.stringify(manifest.version))) {
    throw new Error("Packed userAgent.js does not carry the package version.");
  }

  console.log("Package contents and clean-consumer import verified.");
} finally {
  await Promise.all([
    rm(packDirectory, { recursive: true, force: true }),
    rm(consumerDirectory, { recursive: true, force: true }),
  ]);
}
