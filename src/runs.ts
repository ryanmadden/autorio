import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import { ROOT, DATA_DIR, PORT, FACTORIO_BIN, controlModHash, createMap, factorioVersion, execFileAsync } from "./runtime.js";
import { Benchmark, Snapshot, loadBenchmarks, trackedMilestones, parseSnapshot, reached, TELEMETRY_COMMAND } from "./benchmarks.js";
import { openRunTerminal } from "./run-terminal.js";
import { pacificTimestamp, modelLabel, REASONING_LEVELS, ReasoningLevel } from "./run-labels.js";
import {quotaError} from "./quota.js";
import { sessionUsage } from "./token-usage.js";
import {ObsRunRecorder,obsEnabled,ensureObsRunning,connectObs} from "./obs.js";
import {renderTimelapse} from "./timelapse.js";
import { openRunRecording } from "./recording-window.js";

export type RunState = "preparing" | "launching" | "running" | "saving" | "completed" | "failed" | "stopped" | "timed_out" | "interrupted" | "paused";
type Video = NonNullable<Run["video"]>;
type Segment = {index:number; state:RunState; started_at?:string; ended_at?:string; start_seconds:number; end_seconds?:number; event_offset:number; native_offset:number; session_id?:string; save_file?:string; video?:Video};
type Run = {
  id: string; name?: string; reasoning_effort?: ReasoningLevel; benchmark: Benchmark; state: RunState; created_at: string;
  started_at?: string; ended_at?: string; reason?: string; model?: string;
  agent: "codex" | "manual"; max_seconds: number; elapsed_seconds: number;
  segments?:Segment[];
  checkpoint?:{file:string;sha256:string;saved_at:string;segment:number};
  quota?:{message:string;detected_at:string};
  terminal: boolean;
  recording?: boolean;
  capture_video?: boolean;
  video?: {state:"pending"|"recording"|"rendering"|"ready"|"failed";capture_fps:5;playback_fps:30;speed:6;raw_file?:string;file?:string;error?:string;metadata?:unknown};
  output_format?: "events" | "native";
  baseline_tick?: number; latest?: Snapshot; baseline?: Snapshot;
  milestones: Record<string, { wall_seconds: number; game_ticks: number; observed_at: string; initial?: boolean }>;
  agent_exit?: { code: number | null; signal: string | null };
  session_id?: string; usage?: Record<string, number>; usage_status?: "final" | "last_reported" | "unavailable"; usage_source?: "session_log" | "turn.completed"; versions?: Record<string, string>;
  hashes?: Record<string, string>; warnings: string[];
  actions: { submitted: number; completed: number; failed: number; cancelled: number; partial_failures: number };
};
type Hooks = {
  running(): boolean;
  openRecording?(dir: string): Promise<void>;
  startVideo?(dir:string):Promise<{stop():Promise<string>}>;
  renderVideo?(source:string,dir:string):Promise<any>;
  start(save: string, profile: string, logFile: string): Promise<void>;
  stop(): Promise<void>;
  command(lua: string, timeout?: number): Promise<string>;
  connect(): Promise<void>;
  cancelJobs(): Promise<void>;
};
const terminal = new Set<RunState>(["completed", "failed", "stopped", "timed_out", "interrupted", "paused"]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export class RunManager {
  readonly benchmarks = loadBenchmarks(ROOT);
  readonly root = path.join(DATA_DIR, "runs");
  private runs = new Map<string, Run>();
  private active?: Run;
  private agent?: ChildProcess;
  private abort?: AbortController;
  private monitor?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private sampling = false;
  private ending?: Promise<void>;
  private preparation?: Promise<void>;
  private startedMono = 0;
  private elapsedBefore = 0;
  private telemetryErrors = 0;
  private stopRequested = false;
  private videoRecorder?:{stop():Promise<string>};

  constructor(private hooks: Hooks) {
    fs.mkdirSync(this.root, { recursive: true });
    for (const id of fs.readdirSync(this.root)) {
      const file = path.join(this.root, id, "run.json");
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as Run;
      if (!terminal.has(run.state)) {
        run.state = "interrupted"; run.ended_at = new Date().toISOString();
        run.reason = "Manager exited before this run finished; automatic resume is not supported.";
        this.persist(run);
      }
      if (!run.usage && run.session_id) { this.captureUsage(run); this.persist(run); }
      // A cleanly paused run must remain resumable even if the manager exited
      // while converting its recording. Recover a finished artifact or retain
      // the raw capture and report the interrupted conversion separately.
      let recoveredVideo=false;
      for(const segment of run.segments || []) {
        if(segment.video?.state!=="rendering")continue;
        const dir=segment.index===1?this.dir(run):path.join(this.dir(run),"segments",String(segment.index).padStart(3,"0"));
        try {
          const metadata=JSON.parse(fs.readFileSync(path.join(dir,"video","timelapse.json"),"utf8"));
          const file=path.join(dir,"video","timelapse.mp4");
          if(metadata.fps!==30 || metadata.frames<1 || !fs.existsSync(file))throw new Error("Conversion incomplete");
          Object.assign(segment.video,{state:"ready",file:path.relative(this.dir(run),file),metadata});
        } catch {
          segment.video.state="failed";segment.video.error="Manager exited during conversion; the original recording is retained";
        }
        recoveredVideo=true;
      }
      if(run.segments?.at(-1)?.video)run.video=run.segments.at(-1)!.video;
      if(recoveredVideo)this.persist(run);
      this.runs.set(id, run);
    }
  }

  get busy() { return Boolean(this.active); }
  get acceptingActions() { return this.active?.state === "running"; }
  recordJob(phase: "submitted" | "finished", job: any) {
    const run = this.active;
    if (!run || !["running", "saving"].includes(run.state)) return;
    fs.appendFileSync(path.join(this.dir(run), "jobs.jsonl"), JSON.stringify({ phase, at: new Date().toISOString(), ...job }) + "\n");
    if (phase === "submitted") run.actions.submitted++;
    else {
      if (job.status === "completed") run.actions.completed++;
      if (job.status === "failed") run.actions.failed++;
      if (job.status === "cancelled") run.actions.cancelled++;
      run.actions.partial_failures += (job.results || []).filter((result: any) => result?.ok === false).length;
    }
    this.persist(run);
  }
  private dir(run: Run) { return path.join(this.root, run.id); }
  private persist(run: Run) {
    const file = path.join(this.dir(run), "run.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(run, null, 2));
    fs.renameSync(file + ".tmp", file);
  }
  private elapsed() { return this.elapsedBefore + (this.startedMono ? (performance.now() - this.startedMono) / 1000 : 0); }
  private event(run: Run, text: string) {
    fs.appendFileSync(path.join(this.dir(run), "activity.log"), `[${new Date().toISOString()}] ${text}\n`);
  }
  list() { return [...this.runs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map(run => this.view(run)); }
  get(id: string) { const run = this.runs.get(id); return run ? this.view(run) : undefined; }
  private view(run: Run) {
    return { ...run, resumable:run.state==="paused" && Boolean(run.checkpoint && fs.existsSync(path.join(this.dir(run),run.checkpoint.file))), model_label: modelLabel(run), elapsed_seconds: run === this.active && run.state === "running" ? this.elapsed() : run.elapsed_seconds };
  }
  log(id: string, offset: number, native: boolean | "events" | "telemetry" = false) {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    const file = path.join(this.dir(run), native === "telemetry" ? "telemetry.jsonl" : native === "events" ? "agent.events.jsonl" : native ? "codex.log" : "activity.log");
    if (!fs.existsSync(file)) return native ? { data: "", offset: 0 } : { text: "", offset: 0 };
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.min(Math.max(0, offset), size);
      const buffer = Buffer.alloc(Math.min(size - start, 128 * 1024));
      const length = fs.readSync(fd, buffer, 0, buffer.length, start);
      return native
        ? { data: buffer.subarray(0, length).toString("base64"), offset: start + length }
        : { text: buffer.subarray(0, length).toString("utf8"), offset: start + length };
    } finally { fs.closeSync(fd); }
  }

  start(options: { benchmark?: string; model?: string; reasoning_effort?: string; agent?: string; max_seconds?: number; terminal?: boolean; recording?: boolean; capture_video?:boolean }) {
    if (this.active || this.hooks.running()) throw new Error("Stop the active game/run before starting another run.");
    const benchmark = this.benchmarks.find(b => b.id === (options.benchmark || "smoke"));
    if (!benchmark) throw new Error("Unknown benchmark");
    if (options.agent && !["manual", "codex"].includes(options.agent)) throw new Error("agent must be codex or manual");
    const max = options.max_seconds ?? benchmark.max_seconds;
    if (!Number.isFinite(max) || max < 1 || max > 86400) throw new Error("max_seconds must be between 1 and 86400");
    if (options.model !== undefined && (typeof options.model !== "string" || !options.model.trim())) throw new Error("Invalid model");
    if (options.terminal !== undefined && typeof options.terminal !== "boolean") throw new Error("terminal must be a boolean");
    if (options.recording !== undefined && typeof options.recording !== "boolean") throw new Error("recording must be a boolean");
    if(options.capture_video!==undefined && typeof options.capture_video!=="boolean") throw new Error("capture_video must be a boolean");
    const effort = options.reasoning_effort ?? "low";
    if (!REASONING_LEVELS.includes(effort as ReasoningLevel)) throw new Error(`Invalid reasoning_effort; choose ${REASONING_LEVELS.join(", ")}`);
    const created = new Date();
    const timestamp = pacificTimestamp(created);
    const run: Run = {
      id: `${timestamp.replaceAll(":", "-").replaceAll(" ", "_")}-${randomUUID().slice(0, 8)}`,
      name: `${timestamp} · ${benchmark.id}`, reasoning_effort: options.agent === "manual" ? undefined : effort as ReasoningLevel,
      benchmark: { ...benchmark, milestones: trackedMilestones(benchmark) }, state: "preparing", created_at: created.toISOString(), model: options.model,
      agent: options.agent === "manual" ? "manual" : "codex", max_seconds: max,
      terminal: options.agent !== "manual" && (options.terminal ?? process.env.AUTORIO_TERMINAL === "1"),
      elapsed_seconds: 0, milestones: {}, warnings: [],
      actions: { submitted: 0, completed: 0, failed: 0, cancelled: 0, partial_failures: 0 },
    };
    run.capture_video=run.agent==="codex" && (options.capture_video ?? obsEnabled());
    if(run.capture_video && run.terminal)throw new Error("OBS capture requires the web recording window; use --no-terminal or --no-video");
    if(run.capture_video)run.video={state:"pending",capture_fps:5,playback_fps:30,speed:6};
    run.recording = run.agent === "codex" && !run.terminal && (run.capture_video || (options.recording ?? true));
    run.output_format = run.terminal ? "native" : "events";
    fs.mkdirSync(this.dir(run), { recursive: true });
    this.active = run; this.runs.set(run.id, run); this.persist(run);
    this.beginSegment(run);
    this.abort = new AbortController(); this.ending = undefined; this.startedMono = 0; this.elapsedBefore=0;
    this.stopRequested = false; this.telemetryErrors = 0;
    this.preparation = this.prepare(run).catch(async error => {
      if (!this.stopRequested) await this.finish("failed", errorText(error));
    });
    return this.view(run);
  }

  private beginSegment(run:Run) {
    const size=(name:string)=>{try{return fs.statSync(path.join(this.dir(run),name)).size;}catch{return 0;}};
    run.segments ||= [];
    run.segments.push({index:run.segments.length+1,state:"preparing",start_seconds:run.elapsed_seconds,event_offset:size("agent.events.jsonl"),native_offset:size("codex.log")});
    if(run.capture_video)run.video={state:"pending",capture_fps:5,playback_fps:30,speed:6};
    this.persist(run);
  }
  private segment(run:Run) {return run.segments!.at(-1)!;}
  private segmentDir(run:Run) {return path.join(this.dir(run),"segments",String(this.segment(run).index).padStart(3,"0"));}
  private videoDir(run:Run) {return this.segment(run).index===1?this.dir(run):this.segmentDir(run);}
  resume(id:string) {
    if(this.active || this.hooks.running())throw new Error("Stop the active game/run before resuming another run");
    const run=this.runs.get(id);
    if(!run || run.state!=="paused")throw new Error("Only a paused run can be resumed");
    if(!run.checkpoint || !fs.existsSync(path.join(this.dir(run),run.checkpoint.file)))throw new Error("This run has no saved checkpoint to resume");
    if(sha256(fs.readFileSync(path.join(this.dir(run),run.checkpoint.file)))!==run.checkpoint.sha256)throw new Error("Checkpoint checksum changed; refusing to load a different game");
    if(run.elapsed_seconds>=run.max_seconds)throw new Error("The run has no active play time remaining");
    if(run.video?.state==="rendering")throw new Error("Wait for the current recording segment to finish rendering");
    run.state="preparing";delete run.ended_at;delete run.reason;delete run.agent_exit;
    if(run.usage)run.usage_status="last_reported";
    this.elapsedBefore=run.elapsed_seconds;this.startedMono=0;this.beginSegment(run);
    this.active=run;this.abort=new AbortController();this.ending=undefined;this.stopRequested=false;this.telemetryErrors=0;
    this.preparation=this.prepare(run,true).catch(async error=>{if(!this.stopRequested)await this.finish("paused",`Resume failed: ${errorText(error)}`);});
    return this.view(run);
  }

  private checkCancelled() { if (this.stopRequested) throw new Error("Run stopped"); }
  private async prepare(run: Run, resuming=false) {
    const dir = this.dir(run);
    if(run.capture_video && !this.hooks.startVideo) {
      await ensureObsRunning();
      const client=await connectObs();
      try{if((await client.request("GetRecordStatus")).outputActive)throw new Error("OBS is already recording; refusing to take over an existing recording");}finally{client.close();}
    }
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const version = await factorioVersion(); this.checkCancelled();
    const client = fs.readFileSync(path.join(ROOT, "factorio.py"));
    const instructions = fs.readFileSync(path.join(ROOT, "runs/run_template/AGENTS.md"));
    if(!resuming) {fs.writeFileSync(path.join(workspace, "factorio.py"), client);
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), instructions);}
    fs.writeFileSync(path.join(workspace, "TASK.md"), `# Task\n\n${run.benchmark.task}\n\nTime limit: ${run.max_seconds} wall-clock seconds.\n`);
    fs.writeFileSync(path.join(dir, "benchmark.json"), JSON.stringify(run.benchmark, null, 2));
    let commit = "unknown";
    try { commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim(); } catch { /* optional */ }
    if(resuming && run.versions?.factorio!==version)throw new Error("Factorio version changed since this run started");
    if(!resuming)run.versions = { factorio: version, manager_commit: commit, node: process.version };
    if(!resuming)run.hashes = { client: sha256(client), instructions: sha256(instructions),
      benchmark: sha256(JSON.stringify(run.benchmark)), harness: sha256(
        ["server.ts", "runtime.ts", "runs.ts", "benchmarks.ts"].map(file => file + "\n" + fs.readFileSync(path.join(ROOT, "src", file), "utf8")).join("\n")) };
    if(!resuming) {
      const key = sha256(JSON.stringify({ version, map_gen: run.benchmark.map_gen, mods: controlModHash() }));
      const baselineDir = path.join(DATA_DIR, "baselines", key);
      const baselineSave = path.join(baselineDir, "baseline.zip");
      if (!fs.existsSync(baselineSave)) {
        this.event(run, "Generating fixed-seed baseline map");
        await createMap(baselineSave + ".tmp.zip", path.join(baselineDir, "profile"), run.benchmark.map_gen, this.abort?.signal);
        this.checkCancelled();
        fs.renameSync(baselineSave + ".tmp.zip", baselineSave);
      }
      this.checkCancelled();
      run.hashes!.control_mod=controlModHash();
      run.hashes!.baseline_save = sha256(fs.readFileSync(baselineSave));
      fs.copyFileSync(baselineSave, path.join(dir, "game.zip"));
    }
    run.state = "launching"; this.persist(run); this.event(run, "Launching graphical Factorio; waiting for RCON and a player character");
    await this.hooks.start(resuming?path.join(dir,run.checkpoint!.file):path.join(dir, "game.zip"), path.join(dir, "profile"), path.join(dir, "factorio.log"));
    this.checkCancelled();
    const deadline = performance.now() + Number(process.env.AUTORIO_STARTUP_SECONDS || 180) * 1000;
    let ready: Snapshot | undefined;
    while (performance.now() < deadline) {
      this.checkCancelled();
      if (!this.hooks.running()) throw new Error("Factorio exited during startup. Check factorio.log; ensure Steam is signed in.");
      try {
        await this.hooks.connect();
        ready = parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
        break;
      } catch { await sleep(1000); }
    }
    if (!ready) throw new Error("Factorio readiness timeout. Check for a Steam or game dialog and inspect factorio.log.");
    this.checkCancelled();
    if(!resuming) {
      // The first /sc on a fresh save can only acknowledge achievement disabling.
      const setup = "/sc local p=game.players[1]; if p.controller_type==defines.controllers.cutscene then p.exit_cutscene() end; game.tick_paused=true; game.speed=1; " +
        `p.surface.always_day=${run.benchmark.always_day}; ${run.benchmark.always_day ? "p.surface.daytime=0; " : ""}p.clear_items_inside(); ` +
        Object.entries(run.benchmark.starting_items).map(([name, count]) =>
          `assert(p.insert{name=${JSON.stringify(name)},count=${count}}==${count},'starting inventory does not fit');`).join(" ") +
        " local f=remote.interfaces.freeplay; if f and f.set_skip_intro then remote.call('freeplay','set_skip_intro',true) end; " +
        "if f and f.set_disable_crashsite then remote.call('freeplay','set_disable_crashsite',true) end; rcon.print('ready')";
      if (!(await this.hooks.command(setup)).includes("ready")) throw new Error("Failed to initialize benchmark inventory/settings");
      run.baseline = parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
      run.baseline_tick = run.baseline.tick;
    } else {
      await this.hooks.command("/sc game.tick_paused=true; rcon.print('paused')");
      const loaded=parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
      if(loaded.tick < (run.latest?.tick ?? run.baseline_tick!))throw new Error("Loaded checkpoint is older than the recorded game state");
      fs.writeFileSync(path.join(workspace,"RESUME.md"),`Continue the same benchmark from its saved game. Active play time so far: ${run.elapsed_seconds.toFixed(2)} seconds. Waiting and loading time are excluded.\n\nMilestones: ${JSON.stringify(run.milestones)}\n\nCurrent game snapshot: ${JSON.stringify(loaded)}\n`);
    }
    await this.hooks.command("/sc if remote.interfaces['autorio-control'] then remote.call('autorio-control','reset') end; rcon.print('controls_reset')");
    if (run.agent === "codex") await this.checkCodex(run);
    this.checkCancelled();
    if (run.terminal || run.recording) {
      try {
        if (run.terminal) await openRunTerminal(dir);
        else await (this.hooks.openRecording || openRunRecording)(dir);
      } catch (error) {
        run.warnings.push(`${run.terminal ? "Terminal" : "Recording"} view: ${errorText(error)}`);
        this.persist(run); this.event(run, run.warnings.at(-1)!);
      }
    }
    this.checkCancelled();
    if(run.capture_video) {
      let windowId:number|undefined;
      if(!this.hooks.startVideo) {
        const viewer=JSON.parse(fs.readFileSync(path.join(dir,"recording-window.json"),"utf8"));
        if(Number.isInteger(viewer.window_id) && viewer.window_id>0)windowId=viewer.window_id;
      }
      this.videoRecorder=await (this.hooks.startVideo?this.hooks.startVideo(this.videoDir(run)):ObsRunRecorder.start(this.videoDir(run),undefined,run.id,windowId));
      run.video!.state="recording";this.persist(run);
    }
    this.checkCancelled();
    await this.hooks.command("/sc game.tick_paused=false; rcon.print('running')");
    this.segment(run).started_at=new Date().toISOString();
    run.started_at ||= this.segment(run).started_at;
    for (const m of run.benchmark.milestones) if (!resuming && m.kind === "research" && run.baseline!.research[m.name!]) {
      run.milestones[m.id] = { wall_seconds: 0, game_ticks: 0, observed_at: run.started_at!, initial: true };
      fs.appendFileSync(path.join(dir, "milestones.jsonl"), JSON.stringify({ ...m, ...run.milestones[m.id] }) + "\n");
    }
    this.startedMono = performance.now();
    run.state = "running"; this.segment(run).state="running"; this.persist(run); this.event(run, `Run started (${run.agent}); objective: ${run.benchmark.title}`);
    this.watchdog = setTimeout(() => { void this.finish("timed_out", "Wall-clock time limit reached"); }, Math.max(1,run.max_seconds-run.elapsed_seconds) * 1000);
    if (run.agent === "codex") this.launchCodex(run, workspace, resuming);
    this.monitor = setInterval(() => {
      void this.sample().catch(error => {
        this.telemetryErrors++;
        this.event(run, `Telemetry error: ${errorText(error)}`);
        if (this.telemetryErrors >= 3) void this.finish("failed", "Telemetry failed three consecutive times");
      });
    }, run.benchmark.sample_seconds * 1000);
    await this.sample();
  }

  private codexBin() {
    if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    const installed = (process.env.PATH || "").split(path.delimiter).some(p => fs.existsSync(path.join(p, "codex")));
    return installed ? "codex" : fs.existsSync(bundled) ? bundled : "codex";
  }
  private async checkCodex(run: Run) {
    const { stdout } = await execFileAsync(this.codexBin(), ["--version"], { timeout: 10_000 });
    run.versions!.codex = stdout.trim();
    // Fail before starting the clock if authentication is missing.
    await execFileAsync(this.codexBin(), ["login", "status"], { timeout: 10_000 });
  }
  private launchCodex(run: Run, workspace: string, resuming=false) {
    const usageBeforeTurn=resuming?{...run.usage}:{};
    run.output_format = run.terminal ? "native" : "events";
    this.persist(run);
    const args = ["exec", ...(run.terminal ? ["--color", "always"] : ["--json"]), "--ignore-user-config", "--sandbox", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check", "-C", workspace,
      "--output-last-message", path.join(workspace, "REPORT.md")];
    if (run.model) args.push("--model", run.model);
    if (run.reasoning_effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(run.reasoning_effort)}`);
    if(resuming && run.session_id)args.push("resume",run.session_id);
    args.push((resuming?"Continue the same benchmark from its saved game. Read RESUME.md and re-observe the player/world before acting. ":"")+"Read AGENTS.md and TASK.md, then play Factorio through the Python library until the objective is complete. " +
      "Write Python scripts in this workspace as needed. The game is already running. Do not manage game processes or access raw RCON.");
    const env: NodeJS.ProcessEnv = { ...process.env, FACTORIO_API_BASE: `http://127.0.0.1:${PORT}` };
    delete env.RCON_PASSWORD;
    delete env.OBS_WEBSOCKET_PASSWORD;
    const child = spawn(this.codexBin(), args, { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.agent = child;
    fs.mkdirSync(this.segmentDir(run),{recursive:true});
    fs.writeFileSync(path.join(this.segmentDir(run),"agent-launch.json"),JSON.stringify({executable:this.codexBin(),args},null,2));
    fs.writeFileSync(path.join(this.dir(run), "agent-launch.json"), JSON.stringify({ executable: this.codexBin(), args, api_base: env.FACTORIO_API_BASE }, null, 2));
    let outputTail = "", eventBuffer = "", stderrTail="";
    const limited=(message:string)=>{if(run.state!=="running" || this.ending)return;run.quota={message,detected_at:new Date().toISOString()};void this.finish("paused",`Codex quota exhausted: ${message}`);};
    const eventDecoder = new StringDecoder("utf8");
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      fs.appendFileSync(path.join(this.dir(run), `agent.${stream}.log`), chunk);
      if (run.terminal) {
        // The optional Terminal viewer still receives native human output.
        fs.appendFileSync(path.join(this.dir(run), "codex.log"), chunk);
        fs.appendFileSync(path.join(this.dir(run), "activity.log"), chunk);
        outputTail = (outputTail + chunk.toString()).slice(-4096);
        const session = outputTail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").match(/session id:\s*([a-zA-Z0-9-]+)/i);
        if (session) run.session_id = session[1];
      } else if (stream === "stdout") {
        // Save exact JSONL bytes. The browser decodes partial UTF-8/JSON lines.
        fs.appendFileSync(path.join(this.dir(run), "agent.events.jsonl"), chunk);
        eventBuffer += eventDecoder.write(chunk);
        let newline: number;
        while ((newline = eventBuffer.indexOf("\n")) >= 0) {
          const line = eventBuffer.slice(0, newline); eventBuffer = eventBuffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "thread.started") {run.session_id = event.thread_id;this.segment(run).session_id=event.thread_id;}
            const quota=quotaError(event);if(quota)limited(quota);
            if (event.type === "turn.completed") { run.usage = Object.fromEntries(Object.entries(event.usage as Record<string,number>).map(([key,value])=>[key,value+(usageBeforeTurn[key] || 0)])); run.usage_status = "final"; run.usage_source = "turn.completed"; }
            if (event.type === "item.completed" && event.item) {
              const item = event.item;
              if (item.type === "agent_message" || item.type === "reasoning") this.event(run, item.text || "");
              else if (item.type === "command_execution") this.event(run, `${item.command} (${item.status})\n${item.aggregated_output || ""}`);
            }
          } catch { /* Raw bytes remain available for diagnostics. */ }
        }
      } else fs.appendFileSync(path.join(this.dir(run), "activity.log"), chunk);
      if(stream==="stderr") {
        stderrTail=(stderrTail+chunk.toString()).slice(-8192);
        for(const line of stderrTail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").split("\n")) {
          // Native/error stderr only; JSON tool output is deliberately excluded.
          if(/^(?:ERROR[: ]|you(?:'|’)?ve hit your usage limit)/i.test(line.trim())) {const quota=quotaError({type:"error",message:line});if(quota)limited(quota);}
        }
      }
      this.persist(run);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", error => { void this.finish("failed", `Codex launch failed: ${error.message}`); });
    child.once("close", (code, signal) => {
      run.agent_exit = { code, signal }; this.persist(run);
      this.event(run, `Codex exited (${signal || code})`);
      if (run.state === "running" && !this.ending) {
        void (async () => {
          // Let any already-queued crafting finish, then verify the game independently.
          await sleep(1000);
          if (run.state !== "running" || this.ending) return;
          await this.sample();
          if (!this.ending) await this.finish("failed", code === 0 ? "Agent exited before the objective was verified" : `Codex exited with ${signal || code}`);
        })().catch(error => this.finish("failed", errorText(error)));
      }
    });
  }
  private captureUsage(run: Run) {
    if (run.agent !== "codex") return;
    {
      let usage: Record<string, number> | undefined;
      try { usage = sessionUsage(run.session_id, run.created_at); } catch { /* Usage availability must never stop the game. */ }
      if (usage && (!run.usage || (usage.input_tokens>=(run.usage.input_tokens || 0) && usage.output_tokens>=(run.usage.output_tokens || 0)))) { run.usage = usage; run.usage_status = run.usage_status==="final"?"final":"last_reported"; run.usage_source = "session_log"; }
      else if (!run.usage) run.usage_status = "unavailable";
    }
  }
  private async sample() {
    const run = this.active;
    if (!run || run.state !== "running" || this.sampling || this.ending) return;
    this.sampling = true;
    try {
      if (!this.hooks.running()) throw new Error("Factorio process exited");
      const snapshot = parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
      if (run.state !== "running" || this.ending) return;
      this.telemetryErrors = 0;
      this.captureUsage(run);
      this.recordSnapshot(run,snapshot,this.elapsed());
      if (run.milestones[run.benchmark.completion]) void this.finish("completed", "Objective independently verified from game statistics");
      else if (run.elapsed_seconds >= run.max_seconds) void this.finish("timed_out", "Wall-clock time limit reached");
    } finally { this.sampling = false; }
  }

  private recordSnapshot(run:Run,snapshot:Snapshot,wallSeconds:number) {
    const previous = run.latest || run.baseline!;
    const ticks = snapshot.tick - previous.tick;
    const rates = Object.fromEntries(Object.entries(snapshot.production).map(([name, count]) =>
      [name, ticks > 0 ? (count - (previous.production[name] || 0)) * 3600 / ticks : 0]));
    run.latest = snapshot; run.elapsed_seconds = wallSeconds;
    const now = new Date().toISOString();
    fs.appendFileSync(path.join(this.dir(run), "telemetry.jsonl"), JSON.stringify({
      observed_at: now, wall_seconds: run.elapsed_seconds, game_ticks: snapshot.tick - run.baseline_tick!,
      production_per_game_minute: rates, ...snapshot,
    }) + "\n");
    for (const milestone of run.benchmark.milestones) {
      if (!run.milestones[milestone.id] && reached(milestone, snapshot, run.baseline!)) {
        run.milestones[milestone.id] = { wall_seconds: run.elapsed_seconds,
          game_ticks: snapshot.tick - run.baseline_tick!, observed_at: now };
        fs.appendFileSync(path.join(this.dir(run), "milestones.jsonl"), JSON.stringify({ ...milestone, ...run.milestones[milestone.id] }) + "\n");
        this.event(run, `Milestone ${milestone.id} at ${run.elapsed_seconds.toFixed(1)}s / ${snapshot.tick - run.baseline_tick!} ticks`);
      }
    }
    this.persist(run);
  }

  async stop() {
    if (!this.active) throw new Error("No active run");
    this.stopRequested = true; this.abort?.abort();
    await this.preparation;
    await this.finish("stopped", "Stopped by operator");
  }
  async shutdown() { if (this.active) await this.stop(); }
  private finish(state: RunState, reason: string): Promise<void> {
    if (this.ending) return this.ending;
    const run = this.active;
    if (!run) return Promise.resolve();
    this.ending = this.finalize(run, state, reason);
    return this.ending;
  }
  private async finalize(run: Run, state: RunState, reason: string) {
    if (this.monitor) clearInterval(this.monitor);
    if (this.watchdog) clearTimeout(this.watchdog);
    run.elapsed_seconds = this.elapsed(); run.state = "saving"; run.reason = reason; this.persist(run);
    this.event(run, reason);
    let rawVideo:string|undefined;
    try {
      if(state==="paused" && this.hooks.running())await this.hooks.command("/sc game.tick_paused=true; rcon.print('paused')").catch(error=>run.warnings.push(`Pause game: ${errorText(error)}`));
      if (this.agent?.pid) {
        const child = this.agent;
        try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already exited */ }
        if (child.exitCode === null && child.signalCode === null) {
          await Promise.race([new Promise(resolve => child.once("close", resolve)), sleep(3000)]);
        }
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* group already exited */ }
      }
      this.captureUsage(run);
      this.agent = undefined;
      await this.hooks.cancelJobs();
      if(this.videoRecorder) {
        try {
          if(this.hooks.running())await this.hooks.command("/sc game.tick_paused=true; rcon.print('paused')");
          rawVideo=await this.videoRecorder.stop();
          run.video!.raw_file=path.relative(this.dir(run),rawVideo);run.video!.state="rendering";
        }catch(error){run.video!.state="failed";run.video!.error=errorText(error);run.warnings.push(`OBS recording: ${errorText(error)}`);}
        this.videoRecorder=undefined;
      } else if(run.video?.state==="pending") {run.video.state="failed";run.video.error=reason;}
      if (this.hooks.running()) {
        try {
          await this.hooks.command("/sc game.tick_paused=true; rcon.print('paused')");
          if(state==="paused")this.recordSnapshot(run,parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND)),run.elapsed_seconds);
          const saveName=this.segment(run).index===1?"autorio-final":`autorio-final-${this.segment(run).index}`;
          const finalSave = path.join(this.dir(run), "profile", "saves",saveName+".zip");
          fs.rmSync(finalSave,{force:true});
          const response = await this.hooks.command(`/save ${saveName}`, 30_000);
          this.event(run, `Final save requested: ${response.trim()}`);
          // /save acknowledges before asynchronous writing has finished.
          const until = performance.now() + 30_000;
          while (!fs.existsSync(finalSave) && performance.now() < until) await sleep(200);
          if (!fs.existsSync(finalSave)) throw new Error("Final save was not written");
          fs.copyFileSync(finalSave, path.join(this.dir(run), "final.zip"));
          fs.mkdirSync(this.segmentDir(run),{recursive:true});
          const checkpoint=path.join(this.segmentDir(run),"checkpoint.zip");
          fs.copyFileSync(finalSave,checkpoint);
          run.checkpoint={file:path.relative(this.dir(run),checkpoint),sha256:sha256(fs.readFileSync(checkpoint)),saved_at:new Date().toISOString(),segment:this.segment(run).index};
          this.segment(run).save_file=run.checkpoint.file;
        } catch (error) { run.warnings.push(`Final save: ${errorText(error)}`); }
        await this.hooks.stop();
      }
    } catch (error) {
      run.warnings.push(`Cleanup: ${errorText(error)}`);
    } finally {
      if(state==="paused" && (!run.checkpoint || (this.segment(run).started_at && run.checkpoint.segment!==this.segment(run).index))){state="failed";reason+="; no valid game checkpoint could be saved";}
      const segment=this.segment(run);
      segment.state=state;segment.end_seconds=run.elapsed_seconds;segment.ended_at=new Date().toISOString();segment.session_id=run.session_id;segment.video=run.video;
      this.startedMono=0;this.elapsedBefore=run.elapsed_seconds;
      run.state = state;run.reason=reason; run.ended_at = new Date().toISOString(); this.persist(run);
      fs.writeFileSync(path.join(this.dir(run), "SUMMARY.md"), [
        `# ${run.benchmark.title}`, "", `Run: ${run.name || run.id}`, `Result: ${state}`, `Reason: ${reason}`,
        `Agent: ${modelLabel(run)}`, `Active play time: ${run.elapsed_seconds.toFixed(2)} seconds`,
        `Segments: ${run.segments?.length || 1}`,`Checkpoint: ${run.checkpoint?.file || "unavailable"}`,
        `Tokens: ${run.usage ? JSON.stringify(run.usage) : "unavailable"} (${run.usage_status || "unavailable"})`, "",
        ...Object.entries(run.milestones).map(([id, m]) => `- ${id}: ${m.wall_seconds.toFixed(2)} seconds / ${m.game_ticks} ticks`),
        "", ...run.warnings.map(warning => `Warning: ${warning}`), "",
      ].join("\n"));
      this.event(run, `Run ${state}`);
      this.active = undefined;
      const video=run.video;
      if(rawVideo)void (this.hooks.renderVideo || renderTimelapse)(rawVideo,path.join(this.videoDir(run),"video")).then(metadata=>{
        video!.state="ready";video!.file=path.relative(this.dir(run),path.join(this.videoDir(run),"video","timelapse.mp4"));video!.metadata=metadata;
        this.persist(run);fs.appendFileSync(path.join(this.dir(run),"SUMMARY.md"),`\nSegment ${segment.index} timelapse: ${video!.file} (5 fps capture → 30 fps playback, 6× speed)\n`);
      }).catch(error=>{video!.state="failed";video!.error=errorText(error);run.warnings.push(`Timelapse rendering: ${errorText(error)}`);this.persist(run);});
    }
  }
  videoFile(id:string,index?:number) {const run=this.runs.get(id);if(!run)return;const video=index===undefined?run.video:run.segments?.find(s=>s.index===index)?.video;if(video?.state!=="ready" || !video.file)return;const file=path.resolve(this.dir(run),video.file);if(!file.startsWith(this.dir(run)+path.sep))return;return file;}
}
