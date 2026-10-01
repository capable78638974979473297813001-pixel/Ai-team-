// Starts the production server, sends SIGTERM, and checks it stops cleanly.
// Usage: node scripts/shutdown-check.mjs   (after `npm run build`, with .env.local present)
import { spawn } from "node:child_process";

const port = 3002;
const child = spawn("npx", ["next", "start", "-p", String(port)], {
  env: { ...process.env, NEXT_MANUAL_SIG_HANDLE: "true", APP_URL: `https://localhost:${port}` },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let healthy = false;
for (let i = 0; i < 60 && !healthy; i++) {
  await wait(500);
  healthy = await fetch(`http://localhost:${port}/api/health`).then((r) => r.ok).catch(() => false);
}
if (!healthy) {
  console.error("server never became healthy\n" + out);
  process.kill(-child.pid, "SIGKILL");
  process.exit(1);
}
console.log("✓ production server healthy");
const headers = (await fetch(`http://localhost:${port}/api/providers`)).headers;
if (!headers.get("strict-transport-security")) {
  console.error("✗ HSTS missing");
  process.kill(-child.pid, "SIGKILL");
  process.exit(1);
}
console.log("✓ HSTS set in production");

const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
process.kill(-child.pid, "SIGTERM");
const result = await Promise.race([exited, wait(15_000).then(() => null)]);
if (!result) {
  console.error("✗ server did not exit within 15s");
  process.kill(-child.pid, "SIGKILL");
  process.exit(1);
}
console.log(`✓ exited after SIGTERM (code ${result.code})`);
if (!/SIGTERM: stopping instance/.test(out)) {
  console.error("✗ shutdown handler did not run\n" + out);
  process.exit(1);
}
console.log("✓ graceful shutdown handler ran");
