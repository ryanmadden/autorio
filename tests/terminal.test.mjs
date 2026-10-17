import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

test("terminal forwards only native Codex bytes and exits automatically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-terminal-"));
  const run = { state: "running", benchmark: { title: "Do not display this benchmark title" }, elapsed_seconds: 1, milestones: {} };
  const writeRun = value => { fs.writeFileSync(path.join(dir, "run.tmp"), JSON.stringify(value)); fs.renameSync(path.join(dir, "run.tmp"), path.join(dir, "run.json")); };
  writeRun(run);
  fs.writeFileSync(path.join(dir, "codex.log"), "");
  fs.writeFileSync(path.join(dir, "activity.log"), "Preparing fixed-seed game…\nLoading Factorio…\n");
  const child = spawn(process.execPath, ["dist/terminal-view.js", dir]);
  let output = Buffer.alloc(0);
  child.stdout.on("data", data => { output = Buffer.concat([output, data]); });
  const exit = new Promise((resolve, reject) => { child.once("close", code => resolve(code)); child.once("error", reject); });
  const until = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "terminal-view.json"))) {
    if (Date.now() > until) { child.kill(); throw new Error("Viewer did not start"); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const native = Buffer.from("\x1b[32mcodex\x1b[0m\nI’ll inspect the player.\nexec\npython3 play.py\nsuccess\n");
  fs.appendFileSync(path.join(dir, "codex.log"), native);
  writeRun({ ...run, state: "completed", reason: "Do not display this reason", milestones: { gear: { wall_seconds: 1.2 } } });
  try {
    assert.equal(await exit, 0);
    assert.deepEqual(output, native);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "terminal-view.json"), "utf8")).exited_at);
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
