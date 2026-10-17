import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileAsync } from "./runtime.js";

const shellQuote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A dedicated profile closes only this viewer window when its command exits. */
export async function openRunTerminal(dir: string) {
  const template = await fs.promises.readFile("/System/Applications/Utilities/Terminal.app/Contents/Resources/Initial Settings/Pro.terminal", "utf8");
  const viewer = fileURLToPath(new URL("./terminal-view.js", import.meta.url));
  // Terminal's command parser is not a shell parser. Give it a single executable
  // path without spaces; perform all argument quoting inside our own shell script.
  const launcherDir = await fs.promises.mkdtemp("/private/tmp/autorio-terminal-");
  const launcher = path.join(launcherDir, "view.command");
  await fs.promises.writeFile(launcher, [
    "#!/bin/sh",
    `rm -f -- ${shellQuote(launcher)}`,
    `rmdir -- ${shellQuote(launcherDir)}`,
    "exec " + [process.execPath, viewer, dir].map(shellQuote).join(" "), "",
  ].join("\n"), { mode: 0o700 });
  const profile = template
    .replace(/(<key>name<\/key>\s*)<string>[^<]*<\/string>/, "$1<string>Agent transcript</string>")
    .replace(/(<key>shellExitAction<\/key>\s*)<integer>\d+<\/integer>/, "$1<integer>0</integer>")
    .replace(/(<key>ShowWindowSettingsNameInTitle<\/key>\s*)<false\/>/, "$1<false/>")
    .replace("</dict>", [
      `<key>CommandString</key><string>${xml(launcher)}</string>`,
      // Terminal uses true to run the configured program as the session itself.
      // false runs it inside an interactive shell, leaving a prompt afterward.
      "<key>RunCommandAsShell</key><true/>",
      "<key>columnCount</key><integer>64</integer>",
      "<key>rowCount</key><integer>40</integer>",
      "</dict>",
    ].join("\n"));
  const file = path.join(dir, "Autorio.terminal");
  await fs.promises.writeFile(file, profile, { mode: 0o600 });
  await execFileAsync("/usr/bin/open", ["-a", "Terminal", file], { timeout: 10_000 });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(dir, "terminal-view.json")) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(path.join(dir, "terminal-view.json"))) {
    await fs.promises.rm(launcherDir, { recursive: true, force: true });
    throw new Error("Terminal did not start its viewer. Inspect the Terminal window; full run logs remain available.");
  }
}
