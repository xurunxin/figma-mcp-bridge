import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const script = fileURLToPath(new URL("./windows-json-pipe.ps1", import.meta.url));

test(
  "Windows legacy-code-page PowerShell pipes preserve success and error JSON",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "figma-json-pipe-"));
    for (const errorCase of [false, true]) {
      const log = path.join(directory, `${errorCase ? "error" : "success"}.json`);
      const result = await exec(
        "pwsh.exe",
        [
          "-NoProfile",
          "-File",
          script,
          "-NodePath",
          process.execPath,
          "-CliPath",
          cli,
          "-LogPath",
          log,
          ...(errorCase ? ["-ErrorCase"] : []),
        ],
        { windowsHide: true }
      );
      assert.equal(Number(result.stdout.trim()), errorCase ? 2 : 0);
      const actual = JSON.parse(await readFile(log, "utf8"));
      if (errorCase) {
        assert.equal(actual.ok, false);
        assert.equal(actual.error.code, "UNKNOWN_TOOL");
        assert.equal(actual.error.message, "未知工具：missing-中文-🧩");
      } else {
        const direct = JSON.parse(
          (await exec(process.execPath, [cli, "skills", "show"], { windowsHide: true })).stdout
        );
        assert.deepEqual(actual, direct);
        assert.equal(actual.ok, true);
      }
    }
  }
);
