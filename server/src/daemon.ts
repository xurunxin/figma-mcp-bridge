#!/usr/bin/env node
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { Leader } from "./leader.js";
import { resolvePort, stateDirectory } from "./runtime.js";

async function main(): Promise<void> {
  const port = resolvePort();
  const idleMs = Number(process.env.FIGMA_BRIDGE_IDLE_MS ?? 600_000);
  if (!Number.isInteger(idleMs) || idleMs < 100)
    throw new Error("FIGMA_BRIDGE_IDLE_MS must be >= 100");
  const filename = path.join(stateDirectory(), `daemon-${port}.json`);
  let cleaning = false;
  const leader = new Leader(port, {
    owner: "cli",
    idleMs,
    onStop: () => {
      void cleanup();
    },
  });
  async function cleanup(): Promise<void> {
    if (cleaning) return;
    cleaning = true;
    const recorded = await readFile(filename, "utf8")
      .then((value) => JSON.parse(value))
      .catch(() => ({}));
    if (recorded.instanceId === leader.info.instanceId) await unlink(filename).catch(() => {});
  }
  await leader.start();
  try {
    await writeFile(filename, JSON.stringify(leader.info), { mode: 0o600 });
  } catch (error) {
    leader.stop();
    throw error;
  }
  process.on("SIGINT", () => leader.stop());
  process.on("SIGTERM", () => leader.stop());
  console.error(`Bridge ready on 127.0.0.1:${port} (${leader.info.instanceId})`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
