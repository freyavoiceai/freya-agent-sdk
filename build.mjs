import { build } from "esbuild";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => resolve(here, "src", p);
const out = (p) => resolve(here, "dist", p);
const shared = { bundle: true, sourcemap: true, target: "es2020", logLevel: "info" };

// everything: agents (WebRTC and REST) and speech
await build({ ...shared, entryPoints: [src("index.ts")], format: "esm", outfile: out("index.mjs") });
// agents only
await build({ ...shared, entryPoints: [src("agent/index.ts")], format: "esm", outfile: out("agent.mjs") });
// speech only: no WebRTC dependency, so React Native can import it
await build({ ...shared, entryPoints: [src("speech/index.ts")], format: "esm", outfile: out("speech.mjs") });
// <script> tag: window.Freya
await build({ ...shared, entryPoints: [src("index.ts")], format: "iife", globalName: "Freya", outfile: out("freya-agent-sdk.js") });

execSync("tsc --emitDeclarationOnly --noEmit false", { cwd: here, stdio: "inherit" });
console.log("built dist/");
