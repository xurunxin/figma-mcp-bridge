import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appStatus, startApp, stopApp } from "../dist/app.js";

test(
  "Windows app lifecycle isolates native logs and validates owned PID creation time",
  { skip: process.platform !== "win32", timeout: 70000 },
  async (t) => {
    const compiler = path.join(
      process.env.WINDIR ?? "C:/Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    );
    if (
      !(await access(compiler).then(
        () => true,
        () => false
      ))
    ) {
      t.skip(".NET Framework compiler unavailable for native process fixture");
      return;
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), "figma-app-fixture-"));
    process.env.FIGMA_BRIDGE_STATE_DIR = path.join(directory, "state");
    const fixture = path.join(directory, "Figma.exe"),
      source = path.join(directory, "fixture.cs");
    // This is our own hidden, time-limited test executable; no real Figma process is targeted.
    await writeFile(
      source,
      'class Fixture { static void Main() { System.Console.WriteLine("fixture stdout"); System.Console.Error.WriteLine("fixture stderr"); System.Threading.Thread.Sleep(90000); } }'
    );
    await promisify(execFile)(compiler, ["/nologo", "/target:winexe", `/out:${fixture}`, source], {
      windowsHide: true,
    });
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    assert.equal((await appStatus(fixture)).running, false);
    const started = await startApp({ target: "desktop", path: fixture });
    assert.equal(started.running, true);
    assert.equal(started.wasRunning, false);
    assert.equal(started.opened, true);
    assert.equal(started.reused, false);
    assert.equal(started.owned.length, 1);
    const reused = await startApp({ target: "desktop", path: fixture });
    assert.equal(reused.reused, true);
    assert.equal(reused.wasRunning, true);
    assert.equal(reused.running, true);
    assert.deepEqual(reused.owned, started.owned);
    assert.deepEqual((await appStatus(fixture)).owned, started.owned);
    const filename = path.join(process.env.FIGMA_BRIDGE_STATE_DIR, "app.json");
    const owned = await readFile(filename, "utf8");
    t.after(async () => {
      await writeFile(filename, owned);
      await stopApp(port, { path: fixture, force: true }).catch(() => {});
    });
    assert.equal(
      (await appStatus(fixture)).processes.some((p) => p.pid === started.owned[0].pid),
      true
    );
    // Simulate a reused PID: same executable and PID, different creation time.
    const stale = JSON.parse(owned);
    stale.owned[0].startedAt = "2000-01-01T00:00:00.0000000Z";
    await writeFile(filename, JSON.stringify(stale));
    assert.deepEqual((await appStatus(fixture)).owned, []);
    await assert.rejects(stopApp(port, { path: fixture, force: true }), { code: "APP_NOT_OWNED" });
    process.kill(started.owned[0].pid, 0);
    await writeFile(filename, owned);
    await assert.rejects(stopApp(port, { path: fixture }), (error) => {
      assert.equal(error.code, "APP_CLOSE_BLOCKED");
      assert.equal(error.details.windowCloseRequested, 0);
      assert.deepEqual(error.details.remainingPids, [started.owned[0].pid]);
      return true;
    });
    const stopped = await stopApp(port, { path: fixture, force: true });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.forced, true);
    assert.deepEqual((await appStatus(fixture)).processes, []);
    assert.equal((await appStatus(fixture)).running, false);
    assert.deepEqual((await appStatus(fixture)).owned, []);
  }
);
