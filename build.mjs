import { build } from "esbuild";
import { execSync } from "child_process";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => resolve(here, "src", p);
const out = (p) => resolve(here, "dist", p);

// small-webrtc-transport imports daily-js only for DailyMediaManager, which FreyaClient replaces
// with NativeMicManager. Without this stub the bundle would carry daily-js and its Sentry
// reporting (about 600 KB of code that never runs).
const noDaily = {
  name: "no-daily",
  setup(b) {
    b.onResolve({ filter: /^@daily-co\/daily-js$/ }, () => ({ path: "daily-js", namespace: "no-daily" }));
    b.onLoad({ filter: /.*/, namespace: "no-daily" }, () => ({
      contents: `export default {
        getCallInstance() { return undefined; },
        createCallObject() { throw new Error("daily-js is not part of the Freya SDK"); },
      };`,
      loader: "js",
    }));
  },
};

const shared = { bundle: true, sourcemap: true, target: "es2020", logLevel: "info", metafile: true, plugins: [noDaily] };

const results = [
  // everything: agents (WebRTC and REST) and speech
  await build({ ...shared, entryPoints: [src("index.ts")], format: "esm", outfile: out("index.mjs") }),
  // agents only
  await build({ ...shared, entryPoints: [src("agent/index.ts")], format: "esm", outfile: out("agent.mjs") }),
  // speech only: no WebRTC dependency, so React Native can import it
  await build({ ...shared, entryPoints: [src("speech/index.ts")], format: "esm", outfile: out("speech.mjs") }),
  // <script> tag: window.Freya
  await build({ ...shared, entryPoints: [src("index.ts")], format: "iife", globalName: "Freya", outfile: out("freya-agent-sdk.js") }),
];

// The bundles carry third-party code, so its licenses travel with them.
const packages = new Map();
for (const { metafile } of results) {
  for (const input of Object.keys(metafile.inputs)) {
    const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) packages.set(m[1], resolve(here, "node_modules", m[1]));
  }
}
const notices = [...packages]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, dir]) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
    // Pipecat packages ship no license file; their sources carry "Copyright (c) 2024, Daily", BSD-2-Clause.
    const text = file
      ? readFileSync(join(dir, file), "utf8").trim()
      : `Copyright (c) 2024, Daily\n\nSPDX-License-Identifier: ${pkg.license}\nhttps://spdx.org/licenses/${pkg.license}.html`;
    return `${name}@${pkg.version} (${pkg.license})\n\n${text}`;
  });
writeFileSync(
  out("THIRD_PARTY_NOTICES.txt"),
  `The Freya Agent SDK bundles the following packages.\n\n${notices.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
);

execSync("tsc --emitDeclarationOnly --noEmit false", { cwd: here, stdio: "inherit" });
console.log(`built dist/ (${packages.size} bundled packages listed in THIRD_PARTY_NOTICES.txt)`);
