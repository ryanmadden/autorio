import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, "run.json"))) {
  console.error("Usage: terminal-view RUN_DIRECTORY"); process.exit(1);
}
const viewerState = path.join(dir, "terminal-view.json");
fs.writeFileSync(viewerState, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
// Clear Terminal's startup text. Everything after this is unmodified Codex output.
if (process.stdout.isTTY) {
  // Keep recording titles generic; run metadata stays in the operator UI.
  const title = "Agent transcript";
  process.stdout.write(`\x1b]0;${title}\x07\x1b[2J\x1b[H`);
}
process.on("exit", () => {
  fs.writeFileSync(viewerState, JSON.stringify({ pid: process.pid, exited_at: new Date().toISOString() }));
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(["completed", "failed", "stopped", "timed_out", "interrupted", "paused"]);
const file = path.join(dir, "codex.log");
let offset = 0;
function readOutput() {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(Math.max(0, fs.fstatSync(fd).size - offset), 256 * 1024));
    if (!buffer.length) return;
    const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    offset += length;
    process.stdout.write(buffer.subarray(0, length));
  } finally { fs.closeSync(fd); }
}

for (;;) {
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")); }
  catch { await sleep(200); continue; }
  readOutput();
  if (terminal.has(run.state)) {
    while (fs.existsSync(file) && offset < fs.statSync(file).size) readOutput();
    await sleep(2000);
    break;
  }
  await sleep(200);
}
