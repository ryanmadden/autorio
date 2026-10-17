import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ROOT, DATA_DIR, PORT, execFileAsync } from "./runtime.js";

export const RECORDING_APP = path.join(DATA_DIR, "Autorio Recording.app");
const executable = path.join(RECORDING_APP, "Contents/MacOS/autorio-recording-window");
let building: Promise<void> | undefined;

export async function buildRecordingApp() {
  if (process.platform !== "darwin") throw new Error("The recording window requires macOS");
  if (building) return building;
  building = (async () => {
    const source = path.join(ROOT, "native/recording-window.swift");
    const hash = createHash("sha256").update(await fs.promises.readFile(source)).digest("hex");
    const stamp = path.join(DATA_DIR, "recording-app.sha256");
    if (fs.existsSync(executable) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === hash) return;
    await fs.promises.mkdir(path.dirname(executable), { recursive: true });
    const cache = path.join(DATA_DIR, "swift-module-cache");
    await fs.promises.mkdir(cache, { recursive: true });
    // A developer shell can export SDKROOT for a newer, incompatible SDK. Prefer
    // the installed Command Line Tools' selected SDK unless explicitly overridden.
    const selectedSDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
    const sdk = process.env.AUTORIO_MACOS_SDK || (fs.existsSync(selectedSDK) ? selectedSDK :
      (await execFileAsync("/usr/bin/xcrun", ["--show-sdk-path"])).stdout.trim());
    await execFileAsync("/usr/bin/xcrun", ["swiftc", "-sdk", sdk, "-O", "-module-cache-path", cache, source, "-o", executable], { timeout: 120_000 });
    await fs.promises.writeFile(path.join(RECORDING_APP, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.autorio.recording-window</string>
<key>CFBundleName</key><string>Autorio Recording</string>
<key>CFBundleExecutable</key><string>autorio-recording-window</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>

</dict></plist>`);
    await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", RECORDING_APP], { timeout: 10_000 });
    await fs.promises.writeFile(stamp, hash);
  })();
  try { await building; } finally { building = undefined; }
}

/** Owns a separate WKWebView window; never selects an unrelated browser window. */
export async function openRunRecording(dir: string): Promise<void> {
  await buildRecordingApp();
  const resultFile = path.join(dir, "recording-window.json");
  const run=JSON.parse(fs.readFileSync(path.join(dir,"run.json"),"utf8"));
  const url = `http://127.0.0.1:${PORT}/recording.html?run=${encodeURIComponent(path.basename(dir))}&segment=${run.segments?.at(-1)?.index || 1}`;
  const args = ["--recording-url", url, "--run-file", path.join(dir, "run.json"), "--result", resultFile];
  await fs.promises.rm(resultFile, { force: true });
  // Return once opened; the app monitors run.json and closes itself after the run ends.
  await execFileAsync("/usr/bin/open", ["-n", RECORDING_APP, "--args", ...args], { timeout: 10_000 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      const result = JSON.parse(await fs.promises.readFile(resultFile, "utf8"));
      if (result.status !== "opened") throw new Error(result.message || "Recording page failed to open");
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Recording window did not finish opening. The recording view remains available from the dashboard.");
}
