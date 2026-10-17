import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Read only this run's session log; never inspect other sessions or auth files. */
export function sessionUsage(sessionId: string | undefined, createdAt: string, home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return undefined;
  const dates = new Set<string>();
  for (const timestamp of [Date.parse(createdAt), Date.now()]) for (const delta of [-86400000, 0, 86400000]) {
    const date = new Date(timestamp + delta);
    if (Number.isFinite(date.getTime())) dates.add(date.toISOString().slice(0, 10).replaceAll("-", "/"));
  }
  for (const date of dates) {
    const dir = path.join(home, "sessions", date);
    let names: string[];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith(`-${sessionId}.jsonl`)); } catch { continue; }
    if (names.length !== 1) continue;
    const fd = fs.openSync(path.join(dir, names[0]), "r");
    try {
      let position = fs.fstatSync(fd).size, remainder = "";
      // Scan backward in bounded chunks; long command output must not hide usage.
      while (position > 0) {
        const length = Math.min(position, 65536); position -= length;
        const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, position);
        const lines = (buffer.toString("utf8") + remainder).split("\n");
        remainder = position > 0 ? lines.shift()! : "";
        for (const line of lines.reverse()) {
          if (!line.includes('"token_count"')) continue;
          try {
            const event = JSON.parse(line);
            const usage = event.type === "event_msg" && event.payload?.type === "token_count" && event.payload.info?.total_token_usage;
            if (usage && [usage.input_tokens, usage.output_tokens].every(n => Number.isFinite(n) && n >= 0)) return usage as Record<string, number>;
          } catch { /* An unfinished last line can be retried on the next sample. */ }
        }
      }
    } finally { fs.closeSync(fd); }
  }
  return undefined;
}
