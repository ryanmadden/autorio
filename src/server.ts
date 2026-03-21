import { createServer, IncomingMessage, ServerResponse } from "http";
import { spawn } from "child_process";
import fsSync from "fs";
import { promises as fs } from "fs";
import path from "path";
import net from "net";

const PORT = 3000;
const ROOT = process.cwd();

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fsSync.existsSync(envPath)) return;
  const content = fsSync.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const FACTORIO_DIR = path.join(ROOT, "factorio");
const SAVES_DIR = path.join(FACTORIO_DIR, "saves");
const FACTORIO_BIN = path.join(FACTORIO_DIR, "bin", "x64", "factorio");

const LOG_BUFFER_LIMIT = 500;
const USAGE_SAMPLE_MS = 2000;
const RCON_CHECK_MS = 5000;

const RCON_HOST = process.env.RCON_HOST || "127.0.0.1";
const RCON_PORT = process.env.RCON_PORT ? Number(process.env.RCON_PORT) : null;
const RCON_PASSWORD = process.env.RCON_PASSWORD || "";

const RCON_AUTH_ID = 0x1234;

type LastExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
};

type LogLine = {
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
};

type UsageSnapshot = {
  totalJiffies: number;
  procJiffies: number;
};

type UsageStats = {
  cpuPercent: number | null;
  rssBytes: number | null;
};

type RconStatus = {
  configured: boolean;
  connected: boolean;
  host: string | null;
  port: number | null;
  note: string | null;
  lastError: string | null;
};

type RconPending = {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type RconState = {
  socket: net.Socket | null;
  connected: boolean;
  lastError: string | null;
  lastAttemptAt: number | null;
  buffer: Buffer;
  pending: Map<number, RconPending>;
  nextId: number;
};

type ServerState = {
  proc: ReturnType<typeof spawn> | null;
  save: string | null;
  startedAt: number | null;
  lastExit: LastExit | null;
  logs: LogLine[];
  logTail: { stdout: string; stderr: string };
  usage: UsageStats;
  usagePrev: UsageSnapshot | null;
  rcon: RconState;
};

const state: ServerState = {
  proc: null,
  save: null,
  startedAt: null,
  lastExit: null,
  logs: [],
  logTail: { stdout: "", stderr: "" },
  usage: { cpuPercent: null, rssBytes: null },
  usagePrev: null,
  rcon: {
    socket: null,
    connected: false,
    lastError: null,
    lastAttemptAt: null,
    buffer: Buffer.alloc(0),
    pending: new Map(),
    nextId: 0x2000,
  },
};

function json(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

async function listSaves(): Promise<string[]> {
  const entries = await fs.readdir(SAVES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".zip"))
    .map((e) => e.name)
    .sort();
}

function rconConfigured(): boolean {
  return Boolean(RCON_HOST && RCON_PORT && RCON_PASSWORD);
}

function rconStatus(): RconStatus {
  const configured = rconConfigured();
  if (!configured) {
    return {
      configured: false,
      connected: false,
      host: RCON_HOST || null,
      port: RCON_PORT,
      note: "RCON not configured",
      lastError: null,
    };
  }
  return {
    configured: true,
    connected: state.rcon.connected,
    host: RCON_HOST,
    port: RCON_PORT,
    note: state.rcon.connected ? null : "RCON not connected",
    lastError: state.rcon.lastError,
  };
}

function worldInfoCommand(): string {
  const parts = [
    "/c",
    "local s=game.surfaces[1]",
    "local function safe(get)",
    "local ok,val=pcall(get)",
    "if ok then return val end",
    "return nil",
    "end",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t=="string" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t=="number" or t=="boolean" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local enemy=game.forces['enemy']",
    "local peaceful=safe(function() return game.map_settings.peaceful_mode end)",
    "local evolution=nil",
    "if enemy then",
    "evolution=safe(function() return enemy.evolution_factor end)",
    "if evolution==nil then evolution=safe(function() return enemy.get_evolution_factor() end) end",
    "end",
    "local min=-12",
    "local max=12",
    "local tile_out={}",
    "for y=min,max do",
    "for x=min,max do",
    "local t=s.get_tile(x,y)",
    "table.insert(tile_out,'{\"x\":'..x..',\"y\":'..y..',\"name\":'..esc(t.name)..'}')",
    "end",
    "end",
    "local tiles_json='['..table.concat(tile_out,',')..']'",
    "local entities=safe(function() return s.find_entities_filtered{area={{-12,-12},{13,13}}} end) or {}",
    "local ent_out={}",
    "for i=1,#entities do",
    "local e=entities[i]",
    "local force_name=e.force and e.force.name or nil",
    "local health=safe(function() return e.health end)",
    "local box=nil",
    "local ok_box,proto=pcall(function() return e.prototype end)",
    "if ok_box and proto and proto.collision_box then box=proto.collision_box end",
    "local box_left=nil",
    "local box_top=nil",
    "local box_right=nil",
    "local box_bottom=nil",
    "if box and box.left_top and box.right_bottom then",
    "box_left=e.position.x + box.left_top.x",
    "box_top=e.position.y + box.left_top.y",
    "box_right=e.position.x + box.right_bottom.x",
    "box_bottom=e.position.y + box.right_bottom.y",
    "end",
    "local tile_x=math.floor(e.position.x)",
    "local tile_y=math.floor(e.position.y)",
    "local entry='{\"name\":'..esc(e.name)..',\"type\":'..esc(e.type)..',\"x\":'..esc(e.position.x)",
    "entry=entry..',\"y\":'..esc(e.position.y)..',\"tile_x\":'..esc(tile_x)..',\"tile_y\":'..esc(tile_y)",
    "entry=entry..',\"box_left\":'..esc(box_left)..',\"box_top\":'..esc(box_top)..',\"box_right\":'..esc(box_right)..',\"box_bottom\":'..esc(box_bottom)",
    "entry=entry..',\"direction\":'..esc(e.direction)",
    "entry=entry..',\"force\":'..esc(force_name)..',\"health\":'..esc(health)..'}'",
    "table.insert(ent_out,entry)",
    "end",
    "local entities_json='['..table.concat(ent_out,',')..']'",
    "local out={}",
    "table.insert(out,'\"surface_name\":'..esc(s.name))",
    "table.insert(out,'\"surface_index\":'..esc(s.index))",
    "table.insert(out,'\"seed\":'..esc(s.map_gen_settings.seed))",
    "table.insert(out,'\"peaceful_mode\":'..esc(peaceful))",
    "table.insert(out,'\"tick\":'..esc(game.tick))",
    "table.insert(out,'\"day\":'..esc(math.floor(game.tick/25000)))",
    "table.insert(out,'\"daytime\":'..esc(s.daytime))",
    "table.insert(out,'\"enemy_evolution\":'..esc(evolution or 0))",
    "table.insert(out,'\"pollution\":'..esc(s.get_total_pollution()))",
    "table.insert(out,'\"width\":'..esc(s.map_gen_settings.width))",
    "table.insert(out,'\"height\":'..esc(s.map_gen_settings.height))",
    "table.insert(out,'\"tiles\":'..tiles_json)",
    "table.insert(out,'\"entities\":'..entities_json)",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function placeTestItemsCommand(): string {
  const parts = [
    "/c",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    "local function place(name,x,y)",
    "local ok,err=pcall(function()",
    "s.create_entity{ name=name, position={x=x,y=y}, force=force }",
    "end)",
    "if ok then return {name=name,x=x,y=y,ok=true} end",
    "return {name=name,x=x,y=y,ok=false,error=tostring(err)}",
    "end",
    "local results={}",
    "table.insert(results,place('burner-mining-drill',-6,0))",
    "table.insert(results,place('transport-belt',-3,0))",
    "table.insert(results,place('burner-inserter',0,0))",
    "table.insert(results,place('assembling-machine-1',4,0))",
    "table.insert(results,place('iron-chest',8,0))",
    "local chars=s.find_entities_filtered{name='character'}",
    "if chars and #chars>0 then",
    "pcall(function() chars[1].teleport({0,3}) end)",
    "end",
    "local function esc(v)",
    "local t=type(v)",
    'if t=="string" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t=="number" or t=="boolean" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local out={}",
    "table.insert(out,'\"placed\":[')",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"name\":'..esc(r.name)..',\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "table.insert(out,']')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function statusPayload() {
  const running = Boolean(state.proc && !state.proc.killed);
  const uptimeSec =
    running && state.startedAt
      ? Math.floor((Date.now() - state.startedAt) / 1000)
      : 0;
  return {
    running,
    pid: running && state.proc ? state.proc.pid : null,
    save: state.save,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    uptimeSec,
    lastExit: state.lastExit,
    usage: state.usage,
    rcon: rconStatus(),
  };
}

function pushLog(stream: "stdout" | "stderr", chunk: Buffer) {
  const text = chunk.toString("utf8");
  const tail = state.logTail[stream] + text;
  const lines = tail.split(/\r?\n/);
  state.logTail[stream] = lines.pop() || "";

  const now = new Date().toISOString();
  for (const line of lines) {
    if (!line) continue;
    state.logs.push({ ts: now, stream, line });
  }

  if (state.logs.length > LOG_BUFFER_LIMIT) {
    state.logs.splice(0, state.logs.length - LOG_BUFFER_LIMIT);
  }
}

async function readProcStat(
  pid: number,
): Promise<{ procJiffies: number; rssBytes: number }> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const parts = stat.trim().split(" ");
  const utime = Number(parts[13] || 0);
  const stime = Number(parts[14] || 0);
  const procJiffies = utime + stime;

  const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  const rssBytes = match ? Number(match[1]) * 1024 : 0;

  return { procJiffies, rssBytes };
}

async function readTotalJiffies(): Promise<number> {
  const stat = await fs.readFile("/proc/stat", "utf8");
  const line = stat.split("\n")[0] || "";
  const parts = line.trim().split(/\s+/).slice(1);
  return parts.reduce((sum, v) => sum + Number(v || 0), 0);
}

async function sampleUsage() {
  if (!state.proc || state.proc.killed || !state.proc.pid) {
    state.usage = { cpuPercent: null, rssBytes: null };
    state.usagePrev = null;
    return;
  }

  try {
    const pid = state.proc.pid;
    const [procStat, totalJiffies] = await Promise.all([
      readProcStat(pid),
      readTotalJiffies(),
    ]);

    if (state.usagePrev) {
      const deltaProc = procStat.procJiffies - state.usagePrev.procJiffies;
      const deltaTotal = totalJiffies - state.usagePrev.totalJiffies;
      const cpuPercent = deltaTotal > 0 ? (deltaProc / deltaTotal) * 100 : 0;
      state.usage = { cpuPercent, rssBytes: procStat.rssBytes };
    } else {
      state.usage = { cpuPercent: 0, rssBytes: procStat.rssBytes };
    }

    state.usagePrev = {
      procJiffies: procStat.procJiffies,
      totalJiffies,
    };
  } catch {
    state.usage = { cpuPercent: null, rssBytes: null };
    state.usagePrev = null;
  }
}

function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt16LE(0, 12 + bodyBuf.length);
  return buf;
}

type RconPacket = { id: number; type: number; body: string };

function decodeRconPackets(buffer: Buffer): {
  packets: RconPacket[];
  rest: Buffer;
} {
  const packets: RconPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readInt32LE(offset);
    if (offset + 4 + size > buffer.length) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const bodyStart = offset + 12;
    const bodyEnd = offset + 4 + size - 2;
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buffer.slice(offset) };
}

function handleRconPacket(pkt: RconPacket) {
  if (pkt.id === -1 && state.rcon.pending.has(RCON_AUTH_ID)) {
    const pending = state.rcon.pending.get(RCON_AUTH_ID)!;
    clearTimeout(pending.timer);
    state.rcon.pending.delete(RCON_AUTH_ID);
    pending.reject(new Error("RCON auth failed"));
    return;
  }

  const pending = state.rcon.pending.get(pkt.id);
  if (pending) {
    clearTimeout(pending.timer);
    state.rcon.pending.delete(pkt.id);
    pending.resolve(pkt.body);
  }
}

function attachRconSocket(socket: net.Socket) {
  state.rcon.buffer = Buffer.alloc(0);

  socket.on("data", (data) => {
    state.rcon.buffer = Buffer.concat([state.rcon.buffer, data]);
    const decoded = decodeRconPackets(state.rcon.buffer);
    state.rcon.buffer = decoded.rest;
    for (const pkt of decoded.packets) handleRconPacket(pkt);
  });

  socket.on("close", () => {
    if (state.rcon.socket === socket) {
      state.rcon.socket = null;
      state.rcon.connected = false;
    }
    for (const pending of state.rcon.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("RCON connection closed"));
    }
    state.rcon.pending.clear();
  });
}

function rconSendInternal(
  id: number,
  type: number,
  body: string,
  timeoutMs: number,
) {
  if (!state.rcon.socket) throw new Error("RCON not connected");
  const socket = state.rcon.socket;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.rcon.pending.delete(id);
      reject(new Error("RCON request timeout"));
    }, timeoutMs);

    state.rcon.pending.set(id, { resolve, reject, timer });
    socket.write(encodeRconPacket(id, type, body));
  });
}

async function connectRcon(): Promise<boolean> {
  if (!rconConfigured()) return false;
  if (!RCON_PORT) return false;

  const host = RCON_HOST;
  const port = RCON_PORT;
  state.rcon.lastAttemptAt = Date.now();
  state.rcon.lastError = null;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      finish(false, "RCON auth timeout");
    }, 3000);

    const finish = (ok: boolean, err?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (!ok && err) state.rcon.lastError = err;
      if (!ok) {
        if (state.rcon.socket === socket) {
          state.rcon.socket = null;
          state.rcon.connected = false;
        }
        socket.destroy();
      }
      resolve(ok);
    };

    socket.on("connect", async () => {
      attachRconSocket(socket);
      state.rcon.socket = socket;
      state.rcon.connected = false;
      try {
        await rconSendInternal(RCON_AUTH_ID, 3, RCON_PASSWORD, 3000);
        state.rcon.connected = true;
        socket.setTimeout(0);
        finish(true);
      } catch (err: any) {
        finish(false, err?.message || "RCON auth failed");
      }
    });

    socket.on("error", (err) => finish(false, err.message));
  });
}

function disconnectRcon() {
  if (state.rcon.socket) {
    state.rcon.socket.destroy();
  }
  state.rcon.socket = null;
  state.rcon.connected = false;
}

async function ensureRconConnection() {
  if (!rconConfigured()) return;
  if (!state.proc || state.proc.killed) {
    disconnectRcon();
    return;
  }
  if (state.rcon.connected) return;
  await connectRcon();
}

async function rconCommand(command: string): Promise<string> {
  if (!state.rcon.connected) throw new Error("RCON not connected");
  const id = state.rcon.nextId++;
  return rconSendInternal(id, 2, command, 3000);
}

setInterval(() => {
  sampleUsage().catch(() => {});
}, USAGE_SAMPLE_MS);

setInterval(() => {
  ensureRconConnection().catch(() => {});
}, RCON_CHECK_MS);

async function handleApi(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );

  if (req.method === "GET" && url.pathname === "/api/saves") {
    try {
      const saves = await listSaves();
      return json(res, 200, { saves });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "Failed to list saves" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/server/status") {
    return json(res, 200, statusPayload());
  }

  if (req.method === "GET" && url.pathname === "/api/server/logs") {
    const limitRaw = url.searchParams.get("limit") || "200";
    const limit = Math.max(1, Math.min(1000, Number(limitRaw) || 200));
    const lines = state.logs.slice(-limit);
    return json(res, 200, { lines });
  }

  if (req.method === "GET" && url.pathname === "/api/rcon/world") {
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    try {
      const response = await rconCommand(worldInfoCommand());
      let data: unknown = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      return json(res, 200, { ok: true, response, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/rcon/test-items") {
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    try {
      const response = await rconCommand(placeTestItemsCommand());
      let data: unknown = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      return json(res, 200, { ok: true, response, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/rcon/command") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    const command = body?.command;
    if (!command || typeof command !== "string") {
      return json(res, 400, { error: "Missing command" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    try {
      const response = await rconCommand(command);
      return json(res, 200, { ok: true, response });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/server/start") {
    if (state.proc) {
      return json(res, 409, { error: "Server already running" });
    }

    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }

    const save = body?.save;
    if (!save || typeof save !== "string") {
      return json(res, 400, { error: "Missing save" });
    }

    const savePath = path.join(SAVES_DIR, save);
    if (!save.endsWith(".zip")) {
      return json(res, 400, { error: "Save must be a .zip file" });
    }

    try {
      const stat = await fs.stat(savePath);
      if (!stat.isFile()) {
        return json(res, 400, { error: "Save not found" });
      }
    } catch {
      return json(res, 400, { error: "Save not found" });
    }

    const settingsPath = path.join(
      FACTORIO_DIR,
      "config",
      "server-settings.json",
    );
    const adminlistPath = path.join(
      FACTORIO_DIR,
      "config",
      "server-adminlist.json",
    );
    const args = [
      // "--start-server",
      // savePath,
      "--server-settings",
      settingsPath,
      "--server-adminlist",
      adminlistPath,
      "--start-server-load-scenario",
      "default_lab_scenario",
    ];
    if (rconConfigured()) {
      args.push(
        "--rcon-port",
        String(RCON_PORT),
        "--rcon-password",
        RCON_PASSWORD,
      );
    }

    const proc = spawn(FACTORIO_BIN, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (chunk) => {
      process.stdout.write(`[factorio] ${chunk}`);
      pushLog("stdout", chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      process.stderr.write(`[factorio] ${chunk}`);
      pushLog("stderr", chunk);
    });

    proc.on("exit", (code, signal) => {
      state.lastExit = {
        code,
        signal: signal as NodeJS.Signals | null,
        at: new Date().toISOString(),
      };
      state.proc = null;
      state.save = null;
      state.startedAt = null;
      state.usage = { cpuPercent: null, rssBytes: null };
      state.usagePrev = null;
      disconnectRcon();
    });

    state.proc = proc;
    state.save = save;
    state.startedAt = Date.now();
    state.logs = [];
    state.logTail = { stdout: "", stderr: "" };
    state.usage = { cpuPercent: 0, rssBytes: null };
    state.usagePrev = null;
    state.rcon.lastError = null;

    return json(res, 200, statusPayload());
  }

  if (req.method === "POST" && url.pathname === "/api/server/stop") {
    if (!state.proc) {
      return json(res, 409, { error: "Server not running" });
    }

    state.proc.kill("SIGTERM");
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "Not found" });
}

function contentType(p: string) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function handleStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";
  const relPath = pathname.replace(/^\/+/, "");
  const publicRoot = path.join(ROOT, "public");
  const filePath = path.join(publicRoot, relPath);
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    return res.end();
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    return res.end();
  }

  if (req.url.startsWith("/api/")) {
    return handleApi(req, res);
  }

  return handleStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${signal})...`);
  if (state.proc && !state.proc.killed) {
    state.proc.kill("SIGTERM");
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
