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
const PID_FILE = path.join(ROOT, "factorio.pid");

const LOG_BUFFER_LIMIT = 500;
const USAGE_SAMPLE_MS = 2000;
const RCON_CHECK_MS = 5000;

const RCON_HOST = process.env.RCON_HOST || "127.0.0.1";
const RCON_PORT = process.env.RCON_PORT ? Number(process.env.RCON_PORT) : null;
const RCON_PASSWORD = process.env.RCON_PASSWORD || "";

const RCON_AUTH_ID = 0x1234;
const ALWAYS_DAY_COMMAND = "/c game.surfaces[1].always_day=true";

const AGENT_DEFAULT_RADIUS = 12;
const AGENT_MAX_INVENTORY_SLOTS = 200;
const AGENT_MAX_EQUIPMENT_SLOTS = 50;
const AGENT_MAX_RECIPES = 300;
const AGENT_MAX_RESEARCH = 200;
const AGENT_MAX_ACTIONS = 50;
const CHARACTER_WALK_SPEED_TPS = 8.9;

function parseRconJson<T>(response: string, errorMessage: string): T {
  try {
    return JSON.parse(response) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

function walkDelayMs(distance: number) {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.max(0, Math.round((distance / CHARACTER_WALK_SPEED_TPS) * 1000));
}

function readPidFile(): number | null {
  try {
    const text = fsSync.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(text);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pid: number) {
  fsSync.writeFileSync(PID_FILE, String(pid));
}

function clearPidFile() {
  try {
    fsSync.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    return true;
  }
}

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
  procPid: number | null;
  save: string | null;
  startedAt: number | null;
  lastExit: LastExit | null;
  logs: LogLine[];
  logTail: { stdout: string; stderr: string };
  usage: UsageStats;
  usagePrev: UsageSnapshot | null;
  rcon: RconState;
  alwaysDayPending: boolean;
};

const state: ServerState = {
  proc: null,
  procPid: null,
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
  alwaysDayPending: false,
};

function getRunningPid(): number | null {
  if (state.proc && !state.proc.killed && state.proc.pid) {
    return state.proc.pid;
  }
  if (state.procPid && isPidRunning(state.procPid)) {
    return state.procPid;
  }
  if (state.procPid) {
    state.procPid = null;
    clearPidFile();
  }
  return null;
}

const existingPid = readPidFile();
if (existingPid && isPidRunning(existingPid)) {
  state.procPid = existingPid;
} else if (existingPid) {
  clearPidFile();
}

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
    "/sc",
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
    "local entry='{\"name\":'..esc(e.name)..',\"type\":'..esc(e.type)..',\"x\":'..esc(tile_x)",
    "entry=entry..',\"y\":'..esc(tile_y)..',\"center_x\":'..esc(e.position.x)..',\"center_y\":'..esc(e.position.y)",
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
    "/sc",
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

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function luaString(value: string) {
  return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/\"/g, '\\\\"')}"`;
}

function agentWorldCommand(params: {
  x: number;
  y: number;
  radius: number;
  includeTiles: boolean;
  includeEntities: boolean;
}): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local min_x=${minX}`,
    `local max_x=${maxX}`,
    `local min_y=${minY}`,
    `local max_y=${maxY}`,
    "local tiles_out={}",
    "local tiles_total=0",
    "local tiles_included=0",
    "if true then",
    `local include_tiles=${params.includeTiles ? "true" : "false"}`,
    "if include_tiles then",
    "for y=min_y,max_y do",
    "for x=min_x,max_x do",
    "tiles_total=tiles_total+1",
    "local t=s.get_tile(x,y)",
    "table.insert(tiles_out,'{\"x\":'..x..',\"y\":'..y..',\"name\":'..esc(t.name)..'}')",
    "tiles_included=tiles_included+1",
    "end",
    "end",
    "end",
    "end",
    "local entities_out={}",
    "local entities_total=0",
    "local entities_included=0",
    `local include_entities=${params.includeEntities ? "true" : "false"}`,
    "if include_entities then",
    "local entities=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}} or {}",
    "entities_total=#entities",
    "for i=1,#entities do",
    "local e=entities[i]",
    "local force_name=e.force and e.force.name or nil",
    "local health=e.health",
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
    "local entry='{\"name\":'..esc(e.name)..',\"type\":'..esc(e.type)..',\"x\":'..esc(tile_x)",
    "entry=entry..',\"y\":'..esc(tile_y)..',\"center_x\":'..esc(e.position.x)..',\"center_y\":'..esc(e.position.y)",
    "entry=entry..',\"box_left\":'..esc(box_left)..',\"box_top\":'..esc(box_top)..',\"box_right\":'..esc(box_right)..',\"box_bottom\":'..esc(box_bottom)",
    "entry=entry..',\"direction\":'..esc(e.direction)",
    "entry=entry..',\"force\":'..esc(force_name)..',\"health\":'..esc(health)..'}'",
    "table.insert(entities_out,entry)",
    "entities_included=entities_included+1",
    "end",
    "end",
    "local out={}",
    "table.insert(out,'\"window\":{\"min_x\":'..min_x..',\"min_y\":'..min_y..',\"max_x\":'..max_x..',\"max_y\":'..max_y..'}')",
    "table.insert(out,'\"tiles\":['..table.concat(tiles_out,',')..']')",
    "table.insert(out,'\"entities\":['..table.concat(entities_out,',')..']')",
    "table.insert(out,'\"counts\":{\"tiles_total\":'..tiles_total..',\"tiles_included\":'..tiles_included..',\"entities_total\":'..entities_total..',\"entities_included\":'..entities_included..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentPlayerCommand(params: {
  inventoryLimit: number;
  equipmentLimit: number;
}): string {
  const parts = [
    "/sc",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local inv_limit=${params.inventoryLimit}`,
    `local equip_limit=${params.equipmentLimit}`,
    "local inventories={}",
    "local inv_total=0",
    "local inv_included=0",
    "local function add_inventory(name,inv)",
    "if not inv or not inv.valid then return end",
    "local out={}",
    "for i=1,#inv do",
    "inv_total=inv_total+1",
    "if inv_included < inv_limit then",
    "local stack=inv[i]",
    "if stack and stack.valid_for_read then",
    "local durability=nil",
    "local ammo=nil",
    "local ok_dur, dur=pcall(function() return stack.durability end)",
    "if ok_dur then durability=dur end",
    "local ok_ammo, am=pcall(function() return stack.ammo end)",
    "if ok_ammo then ammo=am end",
    "local entry='{\"slot\":'..i..',\"name\":'..esc(stack.name)..',\"count\":'..stack.count",
    "entry=entry..',\"durability\":'..esc(durability)",
    "entry=entry..',\"ammo\":'..esc(ammo)..'}'",
    "table.insert(out,entry)",
    "inv_included=inv_included+1",
    "end",
    "end",
    "if inv_included >= inv_limit then break end",
    "end",
    "table.insert(inventories,'{\"name\":'..esc(name)..',\"slots\":['..table.concat(out,',')..']}')",
    "end",
    "add_inventory('main',player.get_inventory(defines.inventory.character_main))",
    "add_inventory('guns',player.get_inventory(defines.inventory.character_guns))",
    "add_inventory('ammo',player.get_inventory(defines.inventory.character_ammo))",
    "add_inventory('armor',player.get_inventory(defines.inventory.character_armor))",
    "add_inventory('trash',player.get_inventory(defines.inventory.character_trash))",
    "local equipment_out={}",
    "local equip_total=0",
    "local equip_included=0",
    "local armor=player.get_inventory(defines.inventory.character_armor)",
    "if armor and armor.valid and #armor > 0 then",
    "local stack=armor[1]",
    "if stack and stack.valid_for_read then",
    "local grid=stack.grid",
    "if grid then",
    "for _,eq in pairs(grid.equipment) do",
    "equip_total=equip_total+1",
    "if equip_included < equip_limit then",
    "local entry='{\"name\":'..esc(eq.name)..',\"pos_x\":'..eq.position.x..',\"pos_y\":'..eq.position.y",
    "entry=entry..',\"energy\":'..esc(eq.energy)..'}'",
    "table.insert(equipment_out,entry)",
    "equip_included=equip_included+1",
    "end",
    "end",
    "end",
    "end",
    "end",
    "local craft_out={}",
    "local cq=player.crafting_queue",
    "if cq then",
    "for i=1,#cq do",
    "local c=cq[i]",
    "local entry='{\"recipe\":'..esc(c.recipe)..',\"count\":'..esc(c.count)..',\"prerequisite\":'..esc(c.prerequisite)..'}'",
    "table.insert(craft_out,entry)",
    "end",
    "end",
    "local pf={}",
    "table.insert(pf,'\"name\":'..esc(player.name))",
    "table.insert(pf,'\"x\":'..esc(player.position.x))",
    "table.insert(pf,'\"y\":'..esc(player.position.y))",
    "local direction=nil",
    "if player.character then direction=player.character.direction end",
    "table.insert(pf,'\"direction\":'..esc(direction))",
    "table.insert(pf,'\"health\":'..esc(player.character and player.character.health))",
    "table.insert(pf,'\"energy\":'..esc(player.character and player.character.energy))",
    "table.insert(pf,'\"inventories\":['..table.concat(inventories,',')..']')",
    "table.insert(pf,'\"equipment\":['..table.concat(equipment_out,',')..']')",
    "table.insert(pf,'\"crafting_queue\":['..table.concat(craft_out,',')..']')",
    "local out={}",
    "table.insert(out,'\"player\":{'..table.concat(pf,',')..'}')",
    "table.insert(out,'\"counts\":{\"inventory_total\":'..inv_total..',\"inventory_included\":'..inv_included..',\"equipment_total\":'..equip_total..',\"equipment_included\":'..equip_included..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentResearchCommand(params: { limit: number }): string {
  const parts = [
    "/sc",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local limit=${params.limit}`,
    "local available_out={}",
    "local available_total=0",
    "local available_included=0",
    "for name,tech in pairs(force.technologies) do",
    "if tech.enabled and not tech.researched and #tech.research_unit_ingredients > 0 then",
    "local prereqs_met=true",
    "for _,p in pairs(tech.prerequisites) do",
    "if not p.researched then prereqs_met=false break end",
    "end",
    "if prereqs_met then",
    "available_total=available_total+1",
    "if available_included < limit then",
    "table.insert(available_out,'{\"name\":'..esc(name)..',\"level\":'..esc(tech.level)..'}')",
    "available_included=available_included+1",
    "end",
    "end",
    "end",
    "end",
    "local queue_out={}",
    "if force.research_queue and #force.research_queue > 0 then",
    "for i=1,#force.research_queue do",
    "local tech=force.research_queue[i]",
    "table.insert(queue_out,'{\"name\":'..esc(tech.name)..',\"level\":'..esc(tech.level)..'}')",
    "end",
    "end",
    "local current=nil",
    "if force.current_research then",
    "local tech=force.current_research",
    "current='{\"name\":'..esc(tech.name)..',\"level\":'..esc(tech.level)..',\"progress\":'..esc(force.research_progress)..'}'",
    "end",
    "local out={}",
    "table.insert(out,'\"current\":'..(current or 'null'))",
    "table.insert(out,'\"queue\":['..table.concat(queue_out,',')..']')",
    "table.insert(out,'\"available\":['..table.concat(available_out,',')..']')",
    "table.insert(out,'\"counts\":{\"available_total\":'..available_total..',\"available_included\":'..available_included..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentRecipesCommand(params: {
  limit: number;
  unlockedOnly: boolean;
}): string {
  const parts = [
    "/sc",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local limit=${params.limit}`,
    `local unlocked_only=${params.unlockedOnly ? "true" : "false"}`,
    "local out={}",
    "local total=0",
    "local included=0",
    "for name,recipe in pairs(force.recipes) do",
    "if (not unlocked_only) or recipe.enabled then",
    "total=total+1",
    "if included < limit then",
    "local ingredients_out={}",
    "for _,ing in pairs(recipe.ingredients) do",
    "table.insert(ingredients_out,'{\"name\":'..esc(ing.name)..',\"amount\":'..esc(ing.amount)..'}')",
    "end",
    "local products_out={}",
    "for _,prod in pairs(recipe.products) do",
    "table.insert(products_out,'{\"name\":'..esc(prod.name)..',\"amount\":'..esc(prod.amount)..'}')",
    "end",
    "local entry='{\"name\":'..esc(name)..',\"enabled\":'..esc(recipe.enabled)",
    "entry=entry..',\"energy\":'..esc(recipe.energy)..',\"category\":'..esc(recipe.category)",
    "entry=entry..',\"ingredients\":['..table.concat(ingredients_out,',')..']'",
    "entry=entry..',\"products\":['..table.concat(products_out,',')..']}'",
    "table.insert(out,entry)",
    "included=included+1",
    "end",
    "end",
    "end",
    "local res={}",
    "table.insert(res,'\"recipes\":['..table.concat(out,',')..']')",
    "table.insert(res,'\"counts\":{\"total\":'..total..',\"included\":'..included..'}')",
    "rcon.print('{'..table.concat(res,',')..'}')",
  ];
  return parts.join(" ");
}

function agentBuildCommand(
  items: Array<{ name: string; x: number; y: number; direction?: number }>,
): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "local force=player and player.force or game.forces.player or game.forces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local results={}",
    "local function move_near(x,y)",
    "if not player or not player.character then return false,'no_character' end",
    "local function is_too_close(pos)",
    "if not pos then return true end",
    "local dx=pos.x - x",
    "local dy=pos.y - y",
    "return (dx*dx + dy*dy) < 0.49",
    "end",
    "local safe_pos=s.find_non_colliding_position('character',{x=x,y=y},6,0.5)",
    "if is_too_close(safe_pos) then",
    "local offsets={{1.5,0},{-1.5,0},{0,1.5},{0,-1.5},{1.5,1.5},{-1.5,1.5},{1.5,-1.5},{-1.5,-1.5}}",
    "for i=1,#offsets do",
    "local off=offsets[i]",
    "local candidate=s.find_non_colliding_position('character',{x=x+off[1],y=y+off[2]},6,0.5)",
    "if not is_too_close(candidate) then",
    "safe_pos=candidate",
    "break",
    "end",
    "end",
    "end",
    "if safe_pos then player.teleport(safe_pos) return true end",
    "return false,'out_of_reach'",
    "end",
    "local function place(name,x,y,dir)",
    "if not player or not player.character then return {name=name,x=x,y=y,ok=false,error='no_character'} end",
    "local moved,move_err=move_near(x,y)",
    "if not moved then return {name=name,x=x,y=y,ok=false,error=move_err or 'out_of_reach'} end",
    "local function take_item()",
    "local removed=player.remove_item{name=name,count=1}",
    "if removed < 1 then return 0,'missing_item' end",
    "return removed,nil",
    "end",
    "local can_surface=s.can_place_entity{name=name,position={x=x,y=y},direction=dir,force=force}",
    "local can_player=player.can_place_entity and player.can_place_entity{name=name,position={x=x,y=y},direction=dir,force=force} or can_surface",
    "if not can_player then",
    "if can_surface then",
    "return {name=name,x=x,y=y,ok=false,error='out_of_reach',detail='Target is out of reach'}",
    "end",
    "local colliders=s.find_entities_filtered{area={{x-1,y-1},{x+2,y+2}}} or {}",
    "local blocking=nil",
    "local only_resources=true",
    "for _,c in pairs(colliders) do",
    "if c.valid then",
    "if c.type ~= 'resource' then",
    "only_resources=false",
    "blocking={name=c.name,x=math.floor(c.position.x),y=math.floor(c.position.y)}",
    "break",
    "end",
    "end",
    "end",
    "if only_resources then",
    "local removed,remove_err=take_item()",
    "if remove_err then return {name=name,x=x,y=y,ok=false,error=remove_err} end",
    "local ok_res,created=pcall(function()",
    "return s.create_entity{ name=name, position={x=x,y=y}, direction=dir, force=force }",
    "end)",
    "if ok_res and created then",
    "return {name=name,x=x,y=y,ok=true,center_x=created.position.x,center_y=created.position.y,direction=created.direction}",
    "elseif ok_res then",
    "return {name=name,x=x,y=y,ok=true}",
    "else",
    "player.insert{name=name,count=removed}",
    "return {name=name,x=x,y=y,ok=false,error='create_failed',detail=tostring(created)}",
    "end",
    "end",
    "local tile=s.get_tile(x,y)",
    "local tile_name=tile and tile.name or 'unknown'",
    "if blocking then",
    "return {name=name,x=x,y=y,ok=false,error='collision',detail='Blocked by '..blocking.name..' at '..blocking.x..','..blocking.y,blocking_entity=blocking}",
    "else",
    "return {name=name,x=x,y=y,ok=false,error='invalid_position',tile=tile_name,detail='Cannot place on '..tile_name}",
    "end",
    "end",
    "local removed,remove_err=take_item()",
    "if remove_err then return {name=name,x=x,y=y,ok=false,error=remove_err} end",
    "local ok,result=pcall(function()",
    "return s.create_entity{ name=name, position={x=x,y=y}, direction=dir, force=force }",
    "end)",
    "if ok and result then return {name=name,x=x,y=y,ok=true,center_x=result.position.x,center_y=result.position.y,direction=result.direction} end",
    "if ok then return {name=name,x=x,y=y,ok=true} end",
    "player.insert{name=name,count=removed}",
    "return {name=name,x=x,y=y,ok=false,error='create_failed',detail=tostring(result)}",
    "end",
  ];
  for (const item of items) {
    const dir = item.direction ?? 0;
    parts.push(
      `table.insert(results,place(${luaString(item.name)},${item.x},${item.y},${dir}))`,
    );
  }
  parts.push(
    "local out={}",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"name\":'..esc(r.name)..',\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "if r.detail then entry=entry..',\"detail\":'..esc(r.detail) end",
    "if r.tile then entry=entry..',\"tile\":'..esc(r.tile) end",
    "if r.blocking_entity then",
    "entry=entry..',\"blocking_entity\":{\"name\":'..esc(r.blocking_entity.name)..',\"x\":'..r.blocking_entity.x..',\"y\":'..r.blocking_entity.y..'}'",
    "end",
    "if r.center_x then entry=entry..',\"center_x\":'..esc(r.center_x)..',\"center_y\":'..esc(r.center_y) end",
    "if r.direction then entry=entry..',\"direction\":'..esc(r.direction) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "local results_json='['..table.concat(out,',')..']'",
    "rcon.print('{\"results\":'..results_json..'}')",
  );
  return parts.join(" ");
}

function agentMineCommand(targets: Array<{ x: number; y: number }>): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local results={}",
    "local function find_entity(x,y)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "if #ents > 0 then return ents[1] end",
    "local area={{x-0.5,y-0.5},{x+0.5,y+0.5}}",
    "ents=s.find_entities_filtered{area=area} or {}",
    "for i=1,#ents do",
    "local cand=ents[i]",
    "if cand and cand.valid and cand.minable then return cand end",
    "end",
    "return nil",
    "end",
    "local function ensure_reach(entity)",
    "if not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "local target_pos=entity.position",
    "local safe_pos=s.find_non_colliding_position('character', target_pos, 6, 0.5)",
    "if safe_pos then",
    "player.teleport(safe_pos)",
    "end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local function estimate_mined_count(entity)",
    "local props=entity.prototype and entity.prototype.mineable_properties or nil",
    "local total=0",
    "if props and props.products then",
    "for _,prod in pairs(props.products) do",
    "local amt=prod.amount",
    "if not amt then",
    "if prod.amount_min and prod.amount_max then amt=(prod.amount_min+prod.amount_max)/2 end",
    "if not amt and prod.amount_min then amt=prod.amount_min end",
    "if not amt and prod.amount_max then amt=prod.amount_max end",
    "end",
    "if not amt then amt=1 end",
    "total=total+amt",
    "end",
    "end",
    "if total <= 0 then total = 1 end",
    "return total",
    "end",
    "local function mine(x,y)",
    "local e=find_entity(x,y)",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
    "local ename=e.name",
    "if not e.minable then return {x=x,y=y,name=ename,ok=false,error='not_minable'} end",
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then return {x=x,y=y,name=ename,ok=false,error=reach_err or 'out_of_reach'} end",
    "local mined_count=estimate_mined_count(e)",
    "local ok,err=pcall(function() player.mine_entity(e) end)",
    "if ok then return {x=x,y=y,name=ename,ok=true,mined_count=mined_count} end",
    "return {x=x,y=y,name=ename,ok=false,error=tostring(err)}",
    "end",
  ];
  for (const target of targets) {
    parts.push(`table.insert(results,mine(${target.x},${target.y}))`);
  }
  parts.push(
    "local out={}",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.name then entry=entry..',\"name\":'..esc(r.name) end",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "local results_json='['..table.concat(out,',')..']'",
    "rcon.print('{\"results\":'..results_json..'}')",
  );
  return parts.join(" ");
}

function agentMineProbeCommand(target: { x: number; y: number }): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local function find_entity(x,y)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "if #ents > 0 then return ents[1] end",
    "local area={{x-0.5,y-0.5},{x+0.5,y+0.5}}",
    "ents=s.find_entities_filtered{area=area} or {}",
    "for i=1,#ents do",
    "local cand=ents[i]",
    "if cand and cand.valid and cand.minable then return cand end",
    "end",
    "return nil",
    "end",
    `local target_x=${target.x}`,
    `local target_y=${target.y}`,
    "local e=find_entity(target_x,target_y)",
    "if not e then rcon.print('{\"error\":\"no_entity\"}') return end",
    "local out={}",
    "table.insert(out,'\"player\":{\"x\":'..esc(player.position.x)..',\"y\":'..esc(player.position.y)..'}')",
    "table.insert(out,'\"entity\":{\"name\":'..esc(e.name)..',\"x\":'..esc(e.position.x)..',\"y\":'..esc(e.position.y)..',\"minable\":'..esc(e.minable)..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentPlayerPositionCommand(): string {
  const parts = [
    "/sc",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"error":"No player"}\') return end',
    "rcon.print('{\"player\":{\"x\":'..player.position.x..',\"y\":'..player.position.y..'}}')",
  ];
  return parts.join(" ");
}

function agentEntityProbeCommand(target: { x: number; y: number }): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local function find_entity(x,y)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "if #ents > 0 then return ents[1] end",
    "local area={{x-0.5,y-0.5},{x+0.5,y+0.5}}",
    "ents=s.find_entities_filtered{area=area} or {}",
    "for i=1,#ents do",
    "local cand=ents[i]",
    "if cand and cand.valid then return cand end",
    "end",
    "return nil",
    "end",
    `local target_x=${target.x}`,
    `local target_y=${target.y}`,
    "local e=find_entity(target_x,target_y)",
    "if not e then rcon.print('{\"error\":\"no_entity\"}') return end",
    "local out={}",
    "table.insert(out,'\"player\":{\"x\":'..esc(player.position.x)..',\"y\":'..esc(player.position.y)..'}')",
    "table.insert(out,'\"entity\":{\"name\":'..esc(e.name)..',\"x\":'..esc(e.position.x)..',\"y\":'..esc(e.position.y)..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentMoveCommand(target: { x: number; y: number }): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"ok":false,"error":"No player"}\') return end',
    `local x=${target.x}`,
    `local y=${target.y}`,
    "if not player.character then rcon.print('{\"ok\":false,\"error\":\"no_character\"}') return end",
    "local safe_pos=s.find_non_colliding_position('character',{x=x,y=y},6,0.5)",
    "if not safe_pos then rcon.print('{\"ok\":false,\"error\":\"no_path\"}') return end",
    "player.teleport(safe_pos)",
    "local out={}",
    "table.insert(out,'\"ok\":true')",
    "table.insert(out,'\"x\":'..safe_pos.x)",
    "table.insert(out,'\"y\":'..safe_pos.y)",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentRotateCommand(targets: Array<{ x: number; y: number }>): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "local target_pos=entity.position",
    "local safe_pos=s.find_non_colliding_position('character', target_pos, 6, 0.5)",
    "if safe_pos then player.teleport(safe_pos) end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local results={}",
    "local function rotate(x,y)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then return {x=x,y=y,name=e.name,ok=false,error=reach_err or 'out_of_reach'} end",
    "local ok,err=pcall(function() e.rotate() end)",
    "if ok then return {x=x,y=y,name=e.name,ok=true,direction=e.direction} end",
    "return {x=x,y=y,name=e.name,ok=false,error=tostring(err)}",
    "end",
  ];
  for (const target of targets) {
    parts.push(`table.insert(results,rotate(${target.x},${target.y}))`);
  }
  parts.push(
    "local out={}",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.name then entry=entry..',\"name\":'..esc(r.name) end",
    "if r.direction then entry=entry..',\"direction\":'..esc(r.direction) end",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "local results_json='['..table.concat(out,',')..']'",
    "rcon.print('{\"results\":'..results_json..'}')",
  );
  return parts.join(" ");
}

function agentSetRecipeCommand(
  targets: Array<{ x: number; y: number; recipe: string }>,
): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "local target_pos=entity.position",
    "local safe_pos=s.find_non_colliding_position('character', target_pos, 6, 0.5)",
    "if safe_pos then player.teleport(safe_pos) end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local results={}",
    "local function set_recipe(x,y,recipe)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then return {x=x,y=y,name=e.name,ok=false,error=reach_err or 'out_of_reach'} end",
    "local ok,err=pcall(function() e.set_recipe(recipe) end)",
    "if ok then return {x=x,y=y,name=e.name,ok=true,recipe=recipe} end",
    "return {x=x,y=y,name=e.name,ok=false,error=tostring(err)}",
    "end",
  ];
  for (const target of targets) {
    parts.push(
      `table.insert(results,set_recipe(${target.x},${target.y},${luaString(
        target.recipe,
      )}))`,
    );
  }
  parts.push(
    "local out={}",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.name then entry=entry..',\"name\":'..esc(r.name) end",
    "if r.recipe then entry=entry..',\"recipe\":'..esc(r.recipe) end",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "local results_json='['..table.concat(out,',')..']'",
    "rcon.print('{\"results\":'..results_json..'}')",
  );
  return parts.join(" ");
}

function agentResearchStartCommand(technology: string): string {
  const parts = [
    "/sc",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local tech_name=${luaString(technology)}`,
    "local tech=force.technologies[tech_name]",
    "if not tech then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Technology not found: '..tech_name)..'}')",
    "return",
    "end",
    "if tech.researched then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Already researched: '..tech_name)..'}')",
    "return",
    "end",
    "if not tech.enabled then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Technology not available: '..tech_name)..'}')",
    "return",
    "end",
    "if #tech.research_unit_ingredients == 0 then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Trigger technology (completed by in-game action, not research): '..tech_name)..'}')",
    "return",
    "end",
    "for _,p in pairs(tech.prerequisites) do",
    "if not p.researched then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Missing prerequisite: '..p.name)..'}')",
    "return",
    "end",
    "end",
    "local added=force.add_research(tech)",
    "if not added then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Failed to add research: '..tech_name)..'}')",
    "return",
    "end",
    "local out={}",
    "table.insert(out,'\"ok\":true')",
    "table.insert(out,'\"technology\":'..esc(tech.name))",
    "table.insert(out,'\"level\":'..esc(tech.level))",
    "if force.current_research then",
    "local cr=force.current_research",
    "table.insert(out,'\"current_research\":{\"name\":'..esc(cr.name)..',\"level\":'..esc(cr.level)..',\"progress\":'..esc(force.research_progress)..'}')",
    "end",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentCraftCommand(recipe: string, count: number): string {
  const parts = [
    "/sc",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local recipe=${luaString(recipe)}`,
    `local count=${count}`,
    "local craftable=player.get_craftable_count(recipe)",
    "if craftable < count then",
    "local out={}",
    "table.insert(out,'\"recipe\":'..esc(recipe))",
    "table.insert(out,'\"count\":'..esc(count))",
    "table.insert(out,'\"craftable\":'..esc(craftable))",
    "table.insert(out,'\"ok\":false')",
    "table.insert(out,'\"error\":'..esc('Insufficient ingredients'))",
    "rcon.print('{'..table.concat(out,',')..'}')",
    "return",
    "end",
    "local ok,err=pcall(function() player.begin_crafting{recipe=recipe,count=count} end)",
    "local out={}",
    "table.insert(out,'\"recipe\":'..esc(recipe))",
    "table.insert(out,'\"count\":'..esc(count))",
    "table.insert(out,'\"ok\":'..tostring(ok))",
    "if err then table.insert(out,'\"error\":'..esc(tostring(err))) end",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentInsertCommand(params: {
  x: number;
  y: number;
  item: string;
  count: number;
}): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"ok":false,"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local x=${params.x}`,
    `local y=${params.y}`,
    `local item=${luaString(params.item)}`,
    `local count=${params.count}`,
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "local target_pos=entity.position",
    "local safe_pos=s.find_non_colliding_position('character', target_pos, 6, 0.5)",
    "if safe_pos then player.teleport(safe_pos) end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    'if not e then rcon.print(\'{"ok":false,"error":"no_entity"}\') return end',
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then rcon.print('{\"ok\":false,\"error\":'..esc(reach_err or 'out_of_reach')..'}') return end",
    "local removed=player.remove_item{name=item,count=count}",
    "local inserted=e.insert{name=item,count=removed}",
    "if inserted < removed then player.insert{name=item,count=removed-inserted} end",
    "local out={}",
    "table.insert(out,'\"ok\":true')",
    "table.insert(out,'\"removed\":'..esc(removed))",
    "table.insert(out,'\"inserted\":'..esc(inserted))",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentExtractCommand(params: {
  x: number;
  y: number;
  item: string;
  count: number | "all";
}): string {
  const luaCount = params.count === "all" ? -1 : params.count;
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"ok":false,"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local x=${params.x}`,
    `local y=${params.y}`,
    `local item=${luaString(params.item)}`,
    `local count=${luaCount}`,
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "local target_pos=entity.position",
    "local safe_pos=s.find_non_colliding_position('character', target_pos, 6, 0.5)",
    "if safe_pos then player.teleport(safe_pos) end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    'if not e then rcon.print(\'{"ok":false,"error":"no_entity"}\') return end',
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then rcon.print('{\"ok\":false,\"error\":'..esc(reach_err or 'out_of_reach')..'}') return end",
    "local available=e.get_item_count(item) or 0",
    "if count == -1 then count=available end",
    "if available < count then",
    "local out={}",
    "table.insert(out,'\"ok\":false')",
    "table.insert(out,'\"error\":'..esc('count too high: requested '..count..' but only '..available..' available'))",
    "table.insert(out,'\"available\":'..esc(available))",
    "table.insert(out,'\"requested\":'..esc(count))",
    "rcon.print('{'..table.concat(out,',')..'}')",
    "return",
    "end",
    "if count == 0 then",
    "rcon.print('{\"ok\":true,\"removed\":0,\"inserted\":0}')",
    "return",
    "end",
    "local removed=e.remove_item{name=item,count=count}",
    "local inserted=player.insert{name=item,count=removed}",
    "local out={}",
    "table.insert(out,'\"ok\":true')",
    "table.insert(out,'\"removed\":'..esc(removed))",
    "table.insert(out,'\"inserted\":'..esc(inserted))",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentObserveEntityCommand(
  targets: Array<{ x: number; y: number }>,
): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local results={}",
    "local function find_entity(x,y)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "if #ents > 0 then return ents[1] end",
    "local area={{x-0.5,y-0.5},{x+0.5,y+0.5}}",
    "ents=s.find_entities_filtered{area=area} or {}",
    "for i=1,#ents do",
    "local cand=ents[i]",
    "if cand and cand.valid then return cand end",
    "end",
    "return nil",
    "end",
    "local function observe(x,y)",
    "local e=find_entity(x,y)",
    "if not e then return '{\"x\":'..x..',\"y\":'..y..',\"ok\":false,\"error\":\"no_entity\"}' end",
    "local f={}",
    "table.insert(f,'\"ok\":true')",
    "table.insert(f,'\"name\":'..esc(e.name))",
    "table.insert(f,'\"type\":'..esc(e.type))",
    "table.insert(f,'\"x\":'..esc(math.floor(e.position.x)))",
    "table.insert(f,'\"y\":'..esc(math.floor(e.position.y)))",
    "table.insert(f,'\"center_x\":'..esc(e.position.x))",
    "table.insert(f,'\"center_y\":'..esc(e.position.y))",
    "table.insert(f,'\"direction\":'..esc(e.direction))",
    "local ok_s,status=pcall(function() return e.status end)",
    "if ok_s and status then",
    "local status_names={}",
    "for k,v in pairs(defines.entity_status) do status_names[v]=k end",
    "table.insert(f,'\"status\":'..esc(status_names[status] or tostring(status)))",
    "else",
    "table.insert(f,'\"status\":null')",
    "end",
    "local ok_h,health=pcall(function() return e.health end)",
    "table.insert(f,'\"health\":'..esc(ok_h and health or nil))",
    "local ok_mh,max_health=pcall(function() return e.prototype.max_health end)",
    "table.insert(f,'\"max_health\":'..esc(ok_mh and max_health or nil))",
    "local ok_e,energy=pcall(function() return e.energy end)",
    "table.insert(f,'\"energy\":'..esc(ok_e and energy or nil))",
    "local fuel_out={}",
    "local ok_fi,fi=pcall(function() return e.get_fuel_inventory() end)",
    "if ok_fi and fi and fi.valid then",
    "for i=1,#fi do",
    "local stack=fi[i]",
    "if stack and stack.valid_for_read then",
    "table.insert(fuel_out,'{\"name\":'..esc(stack.name)..',\"count\":'..stack.count..'}')",
    "end",
    "end",
    "end",
    "table.insert(f,'\"fuel_inventory\":['..table.concat(fuel_out,',')..']')",
    "local fb_out={}",
    "local ok_fb,fb_count=pcall(function() return #e.fluidbox end)",
    "if ok_fb and fb_count and fb_count > 0 then",
    "for i=1,fb_count do",
    "local fb_entry={}",
    "table.insert(fb_entry,'\"index\":'..i)",
    "local ok_fluid,fluid=pcall(function() return e.fluidbox[i] end)",
    "if ok_fluid and fluid then",
    "table.insert(fb_entry,'\"fluid\":'..esc(fluid.name))",
    "table.insert(fb_entry,'\"amount\":'..esc(fluid.amount))",
    "else",
    "table.insert(fb_entry,'\"fluid\":null')",
    "table.insert(fb_entry,'\"amount\":0')",
    "end",
    "local ok_conn,conns=pcall(function() return e.fluidbox.get_connections(i) end)",
    "local conn_out={}",
    "if ok_conn and conns then",
    "for _,c in pairs(conns) do",
    "local owner=c.owner",
    "if owner then",
    "table.insert(conn_out,'{\"name\":'..esc(owner.name)..',\"x\":'..esc(math.floor(owner.position.x))..',\"y\":'..esc(math.floor(owner.position.y))..'}')",
    "end",
    "end",
    "end",
    "table.insert(fb_entry,'\"connected_to\":['..table.concat(conn_out,',')..']')",
    "table.insert(fb_out,'{'..table.concat(fb_entry,',')..'}')",
    "end",
    "end",
    "table.insert(f,'\"fluid_boxes\":['..table.concat(fb_out,',')..']')",
    "local ok_r,recipe=pcall(function() local r=e.get_recipe() return r and r.name or nil end)",
    "table.insert(f,'\"recipe\":'..esc(ok_r and recipe or nil))",
    "local output_out={}",
    "local ok_oi,oi=pcall(function() return e.get_output_inventory() end)",
    "if ok_oi and oi and oi.valid then",
    "for i=1,#oi do",
    "local stack=oi[i]",
    "if stack and stack.valid_for_read then",
    "table.insert(output_out,'{\"name\":'..esc(stack.name)..',\"count\":'..stack.count..'}')",
    "end",
    "end",
    "end",
    "table.insert(f,'\"output_inventory\":['..table.concat(output_out,',')..']')",
    "return '{'..table.concat(f,',')..'}'",
    "end",
  ];
  for (const target of targets) {
    parts.push(`table.insert(results,observe(${target.x},${target.y}))`);
  }
  parts.push(
    "rcon.print('{\"results\":['..table.concat(results,',')..']}')",
  );
  return parts.join(" ");
}

function agentResourcesCommand(params: {
  x: number;
  y: number;
  radius: number;
}): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local min_x=${minX}`,
    `local max_x=${maxX}`,
    `local min_y=${minY}`,
    `local max_y=${maxY}`,
    "local resources=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}},type='resource'} or {}",
    "local groups={}",
    "for i=1,#resources do",
    "local e=resources[i]",
    "local n=e.name",
    "if not groups[n] then groups[n]={count=0,amount=0,min_x=e.position.x,min_y=e.position.y,max_x=e.position.x,max_y=e.position.y,sum_x=0,sum_y=0} end",
    "local g=groups[n]",
    "g.count=g.count+1",
    "g.amount=g.amount+(e.amount or 0)",
    "g.sum_x=g.sum_x+e.position.x",
    "g.sum_y=g.sum_y+e.position.y",
    "if e.position.x < g.min_x then g.min_x=e.position.x end",
    "if e.position.y < g.min_y then g.min_y=e.position.y end",
    "if e.position.x > g.max_x then g.max_x=e.position.x end",
    "if e.position.y > g.max_y then g.max_y=e.position.y end",
    "end",
    "local out={}",
    "for name,g in pairs(groups) do",
    "local cx=math.floor(g.sum_x/g.count)",
    "local cy=math.floor(g.sum_y/g.count)",
    "table.insert(out,'{\"name\":'..esc(name)..',\"tile_count\":'..g.count..',\"amount\":'..g.amount..',\"center\":{\"x\":'..cx..',\"y\":'..cy..'},\"bounds\":{\"min_x\":'..math.floor(g.min_x)..',\"min_y\":'..math.floor(g.min_y)..',\"max_x\":'..math.floor(g.max_x)..',\"max_y\":'..math.floor(g.max_y)..'}}')",
    "end",
    "rcon.print('{\"patches\":['..table.concat(out,',')..'],\"total_entities\":'..#resources..'}')",
  ];
  return parts.join(" ");
}

function agentEntityPrototypeCommand(name: string): string {
  const parts = [
    "/sc",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local name=${luaString(name)}`,
    "local proto=game.entity_prototypes[name]",
    "if not proto then rcon.print('{\"ok\":false,\"error\":'..esc('Unknown entity: '..name)..'}') return end",
    "local w=0 local h=0",
    "if proto.collision_box then",
    "local cb=proto.collision_box",
    "w=math.ceil(cb.right_bottom.x - cb.left_top.x)",
    "h=math.ceil(cb.right_bottom.y - cb.left_top.y)",
    "end",
    "local fb_out={}",
    "if proto.fluidbox_prototypes then",
    "for i,fb in pairs(proto.fluidbox_prototypes) do",
    "local conns={}",
    "if fb.pipe_connections then",
    "for _,pc in pairs(fb.pipe_connections) do",
    "local pos_out={}",
    "if pc.positions then",
    "for pi,pos in pairs(pc.positions) do",
    "table.insert(pos_out,'{\"x\":'..esc(pos.x)..',\"y\":'..esc(pos.y)..'}')",
    "end",
    "end",
    "table.insert(conns,'{\"type\":'..esc(pc.type)..',\"positions\":['..table.concat(pos_out,',')..']}')",
    "end",
    "end",
    "table.insert(fb_out,'{\"production_type\":'..esc(fb.production_type)..',\"pipe_connections\":['..table.concat(conns,',')..']}')",
    "end",
    "end",
    "local energy_type='none'",
    "if proto.electric_energy_source_prototype then energy_type='electric'",
    "elseif proto.burner_prototype then energy_type='burner'",
    "end",
    "local fuel_cats={}",
    "if proto.burner_prototype and proto.burner_prototype.fuel_categories then",
    "for cat,_ in pairs(proto.burner_prototype.fuel_categories) do",
    "table.insert(fuel_cats,esc(cat))",
    "end",
    "end",
    "local out={}",
    "table.insert(out,'\"name\":'..esc(name))",
    "table.insert(out,'\"width\":'..w)",
    "table.insert(out,'\"height\":'..h)",
    "table.insert(out,'\"fluid_boxes\":['..table.concat(fb_out,',')..']')",
    "table.insert(out,'\"energy_type\":'..esc(energy_type))",
    "table.insert(out,'\"fuel_categories\":['..table.concat(fuel_cats,',')..']')",
    "table.insert(out,'\"max_health\":'..esc(proto.max_health))",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function statusPayload() {
  const pid = getRunningPid();
  const running = Boolean(pid);
  const uptimeSec =
    running && state.startedAt
      ? Math.floor((Date.now() - state.startedAt) / 1000)
      : 0;
  return {
    running,
    pid: running ? pid : null,
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
  const pid = getRunningPid();
  if (!pid) {
    state.usage = { cpuPercent: null, rssBytes: null };
    state.usagePrev = null;
    return;
  }

  try {
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
        if (state.alwaysDayPending) {
          try {
            await rconCommand(ALWAYS_DAY_COMMAND);
            state.alwaysDayPending = false;
          } catch (err: any) {
            state.rcon.lastError = err?.message || "Failed to set always_day";
          }
        }
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
  if (!getRunningPid()) {
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

  if (req.method === "POST" && url.pathname === "/api/agent/observe/world") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const window = body?.window || {};
    const include: string[] = Array.isArray(body?.include)
      ? body.include
      : ["tiles", "entities"];
    const includeTiles = include.includes("tiles");
    const includeEntities = include.includes("entities");
    const radius = clampInt(window.radius, AGENT_DEFAULT_RADIUS, 1, 200);
    const x = clampInt(window.x, 0, -1000000, 1000000);
    const y = clampInt(window.y, 0, -1000000, 1000000);
    try {
      const response = await rconCommand(
        agentWorldCommand({
          x,
          y,
          radius,
          includeTiles,
          includeEntities,
        }),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      const counts = data?.counts || {};
      const truncated =
        (includeTiles && counts.tiles_included < counts.tiles_total) ||
        (includeEntities && counts.entities_included < counts.entities_total);
      return json(res, 200, {
        ok: true,
        data,
        truncated,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/player") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const limits = body?.limits || {};
    const inventoryLimit = clampInt(
      limits.inventory_slots,
      AGENT_MAX_INVENTORY_SLOTS,
      1,
      AGENT_MAX_INVENTORY_SLOTS,
    );
    const equipmentLimit = clampInt(
      limits.equipment_slots,
      AGENT_MAX_EQUIPMENT_SLOTS,
      1,
      AGENT_MAX_EQUIPMENT_SLOTS,
    );
    try {
      const response = await rconCommand(
        agentPlayerCommand({ inventoryLimit, equipmentLimit }),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      const counts = data?.counts || {};
      const truncated =
        counts.inventory_included < counts.inventory_total ||
        counts.equipment_included < counts.equipment_total;
      return json(res, 200, { ok: true, data, truncated });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/research") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const limits = body?.limits || {};
    const limit = clampInt(
      limits.available,
      AGENT_MAX_RESEARCH,
      1,
      AGENT_MAX_RESEARCH,
    );
    try {
      const response = await rconCommand(agentResearchCommand({ limit }));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      const counts = data?.counts || {};
      const truncated = counts.available_included < counts.available_total;
      return json(res, 200, { ok: true, data, truncated });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/recipes") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const limits = body?.limits || {};
    const limit = clampInt(
      limits.recipes,
      AGENT_MAX_RECIPES,
      1,
      AGENT_MAX_RECIPES,
    );
    const filters = body?.filters || {};
    const unlockedOnly = Boolean(filters.unlocked);
    try {
      const response = await rconCommand(
        agentRecipesCommand({ limit, unlockedOnly }),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      const counts = data?.counts || {};
      const truncated = counts.included < counts.total;
      return json(res, 200, { ok: true, data, truncated });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/build") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const entities: any[] = Array.isArray(body?.entities) ? body.entities : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = entities
      .slice(0, max)
      .filter((e) => e?.name && e?.x !== undefined && e?.y !== undefined);
    try {
      const results: any[] = [];
      for (const entity of trimmed) {
        const probeResponse = await rconCommand(agentPlayerPositionCommand());
        const probe = parseRconJson<any>(
          probeResponse,
          "RCON probe returned invalid JSON",
        );
        if (probe?.error) {
          results.push({
            name: entity?.name,
            x: Number(entity.x),
            y: Number(entity.y),
            ok: false,
            error: probe.error,
          });
          continue;
        }
        const playerPos = probe?.player;
        if (
          !playerPos ||
          !Number.isFinite(playerPos.x) ||
          !Number.isFinite(playerPos.y)
        ) {
          results.push({
            name: entity?.name,
            x: Number(entity.x),
            y: Number(entity.y),
            ok: false,
            error: "probe_failed",
          });
          continue;
        }
        const targetX = Number(entity.x) + 0.5;
        const targetY = Number(entity.y) + 0.5;
        const distance = Math.hypot(targetX - playerPos.x, targetY - playerPos.y);
        const delayMs = walkDelayMs(distance);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const response = await rconCommand(agentBuildCommand([entity]));
        const data = parseRconJson<any>(
          response,
          "RCON build returned invalid JSON",
        );
        const entry = data?.results?.[0];
        if (!entry) {
          results.push({
            name: entity?.name,
            x: Number(entity.x),
            y: Number(entity.y),
            ok: false,
            error: "build_failed",
          });
        } else {
          results.push(entry);
        }
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: entities.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/mine") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets
      .slice(0, max)
      .filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const probeResponse = await rconCommand(
          agentMineProbeCommand({ x: Number(target.x), y: Number(target.y) }),
        );
        const probe = parseRconJson<any>(
          probeResponse,
          "RCON probe returned invalid JSON",
        );
        if (probe?.error) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: probe.error,
          });
          continue;
        }
        const playerPos = probe?.player;
        const entityPos = probe?.entity;
        if (
          !playerPos ||
          !entityPos ||
          !Number.isFinite(playerPos.x) ||
          !Number.isFinite(playerPos.y) ||
          !Number.isFinite(entityPos.x) ||
          !Number.isFinite(entityPos.y)
        ) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "probe_failed",
          });
          continue;
        }
        const dx = entityPos.x - playerPos.x;
        const dy = entityPos.y - playerPos.y;
        const distance = Math.hypot(dx, dy);
        const delayMs = walkDelayMs(distance);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const response = await rconCommand(
          agentMineCommand([{ x: Number(target.x), y: Number(target.y) }]),
        );
        const data = parseRconJson<any>(
          response,
          "RCON mine returned invalid JSON",
        );
        const entry = data?.results?.[0];
        if (!entry) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "mine_failed",
          });
        } else {
          results.push(entry);
          if (entry?.ok) {
            const minedCountRaw = Number(entry?.mined_count);
            const minedCount = Number.isFinite(minedCountRaw)
              ? Math.max(1, Math.ceil(minedCountRaw))
              : 1;
            const postDelayMs = minedCount * 2000;
            if (postDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, postDelayMs));
            }
          }
        }
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/move") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets
      .slice(0, max)
      .filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const probeResponse = await rconCommand(agentPlayerPositionCommand());
        const probe = parseRconJson<any>(
          probeResponse,
          "RCON probe returned invalid JSON",
        );
        if (probe?.error) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: probe.error,
          });
          continue;
        }
        const playerPos = probe?.player;
        if (
          !playerPos ||
          !Number.isFinite(playerPos.x) ||
          !Number.isFinite(playerPos.y)
        ) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "probe_failed",
          });
          continue;
        }
        const targetX = Number(target.x) + 0.5;
        const targetY = Number(target.y) + 0.5;
        const distance = Math.hypot(targetX - playerPos.x, targetY - playerPos.y);
        const delayMs = walkDelayMs(distance);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const response = await rconCommand(
          agentMoveCommand({ x: Number(target.x), y: Number(target.y) }),
        );
        const data = parseRconJson<any>(
          response,
          "RCON move returned invalid JSON",
        );
        if (!data || data.ok === false) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: data?.error || "move_failed",
          });
        } else {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: true,
            moved_x: data?.x,
            moved_y: data?.y,
          });
        }
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/rotate") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets
      .slice(0, max)
      .filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const probeResponse = await rconCommand(
          agentEntityProbeCommand({ x: Number(target.x), y: Number(target.y) }),
        );
        const probe = parseRconJson<any>(
          probeResponse,
          "RCON probe returned invalid JSON",
        );
        if (probe?.error) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: probe.error,
          });
          continue;
        }
        const playerPos = probe?.player;
        const entityPos = probe?.entity;
        if (
          !playerPos ||
          !entityPos ||
          !Number.isFinite(playerPos.x) ||
          !Number.isFinite(playerPos.y) ||
          !Number.isFinite(entityPos.x) ||
          !Number.isFinite(entityPos.y)
        ) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "probe_failed",
          });
          continue;
        }
        const distance = Math.hypot(
          entityPos.x - playerPos.x,
          entityPos.y - playerPos.y,
        );
        const delayMs = walkDelayMs(distance);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const response = await rconCommand(
          agentRotateCommand([{ x: Number(target.x), y: Number(target.y) }]),
        );
        const data = parseRconJson<any>(
          response,
          "RCON rotate returned invalid JSON",
        );
        const entry = data?.results?.[0];
        if (!entry) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "rotate_failed",
          });
        } else {
          results.push(entry);
        }
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/set-recipe") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets
      .slice(0, max)
      .filter((t) => t?.x !== undefined && t?.y !== undefined && t?.recipe);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const probeResponse = await rconCommand(
          agentEntityProbeCommand({ x: Number(target.x), y: Number(target.y) }),
        );
        const probe = parseRconJson<any>(
          probeResponse,
          "RCON probe returned invalid JSON",
        );
        if (probe?.error) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: probe.error,
          });
          continue;
        }
        const playerPos = probe?.player;
        const entityPos = probe?.entity;
        if (
          !playerPos ||
          !entityPos ||
          !Number.isFinite(playerPos.x) ||
          !Number.isFinite(playerPos.y) ||
          !Number.isFinite(entityPos.x) ||
          !Number.isFinite(entityPos.y)
        ) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "probe_failed",
          });
          continue;
        }
        const distance = Math.hypot(
          entityPos.x - playerPos.x,
          entityPos.y - playerPos.y,
        );
        const delayMs = walkDelayMs(distance);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const response = await rconCommand(
          agentSetRecipeCommand([
            { x: Number(target.x), y: Number(target.y), recipe: target.recipe },
          ]),
        );
        const data = parseRconJson<any>(
          response,
          "RCON set-recipe returned invalid JSON",
        );
        const entry = data?.results?.[0];
        if (!entry) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "set_recipe_failed",
          });
        } else {
          results.push(entry);
        }
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/craft") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const recipe = body?.item || body?.recipe;
    const count = clampInt(body?.count, 1, 1, 10000);
    if (!recipe || typeof recipe !== "string") {
      return json(res, 400, { error: "Missing recipe" });
    }
    try {
      const response = await rconCommand(agentCraftCommand(recipe, count));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      if (data && typeof data === "object" && data.ok === false) {
        return json(res, 400, {
          error: data?.error || "Extract failed",
          data,
        });
      }
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/insert") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const to = body?.to?.entity || body?.entity || {};
    const item = body?.item;
    const count = clampInt(body?.count, 1, 1, 100000);
    if (!item || typeof item !== "string") {
      return json(res, 400, { error: "Missing item" });
    }
    if (to?.x === undefined || to?.y === undefined) {
      return json(res, 400, { error: "Missing target" });
    }
    try {
      const probeResponse = await rconCommand(
        agentEntityProbeCommand({ x: Number(to.x), y: Number(to.y) }),
      );
      const probe = parseRconJson<any>(
        probeResponse,
        "RCON probe returned invalid JSON",
      );
      if (probe?.error) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: probe.error },
        });
      }
      const playerPos = probe?.player;
      const entityPos = probe?.entity;
      if (
        !playerPos ||
        !entityPos ||
        !Number.isFinite(playerPos.x) ||
        !Number.isFinite(playerPos.y) ||
        !Number.isFinite(entityPos.x) ||
        !Number.isFinite(entityPos.y)
      ) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: "probe_failed" },
        });
      }
      const distance = Math.hypot(
        entityPos.x - playerPos.x,
        entityPos.y - playerPos.y,
      );
      const delayMs = walkDelayMs(distance);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const response = await rconCommand(
        agentInsertCommand({ x: Number(to.x), y: Number(to.y), item, count }),
      );
      const data = parseRconJson<any>(
        response,
        "RCON insert returned invalid JSON",
      );
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/extract") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const from = body?.from?.entity || body?.entity || {};
    const item = body?.item;
    const rawCount = body?.count;
    const countAll = rawCount === "all" || rawCount === -1;
    const count: number | "all" = countAll
      ? "all"
      : clampInt(rawCount, 1, 1, 100000);
    if (!item || typeof item !== "string") {
      return json(res, 400, { error: "Missing item" });
    }
    if (from?.x === undefined || from?.y === undefined) {
      return json(res, 400, { error: "Missing target" });
    }
    try {
      const probeResponse = await rconCommand(
        agentEntityProbeCommand({ x: Number(from.x), y: Number(from.y) }),
      );
      const probe = parseRconJson<any>(
        probeResponse,
        "RCON probe returned invalid JSON",
      );
      if (probe?.error) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: probe.error },
        });
      }
      const playerPos = probe?.player;
      const entityPos = probe?.entity;
      if (
        !playerPos ||
        !entityPos ||
        !Number.isFinite(playerPos.x) ||
        !Number.isFinite(playerPos.y) ||
        !Number.isFinite(entityPos.x) ||
        !Number.isFinite(entityPos.y)
      ) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: "probe_failed" },
        });
      }
      const distance = Math.hypot(
        entityPos.x - playerPos.x,
        entityPos.y - playerPos.y,
      );
      const delayMs = walkDelayMs(distance);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const response = await rconCommand(
        agentExtractCommand({
          x: Number(from.x),
          y: Number(from.y),
          item,
          count,
        }),
      );
      const data = parseRconJson<any>(
        response,
        "RCON extract returned invalid JSON",
      );
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/entity") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets
      .slice(0, max)
      .filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const response = await rconCommand(agentObserveEntityCommand(trimmed));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      return json(res, 200, {
        ok: true,
        data,
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/agent/observe/resources"
  ) {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const window = body?.window || {};
    const radius = clampInt(window.radius, 50, 1, 500);
    const x = clampInt(window.x, 0, -1000000, 1000000);
    const y = clampInt(window.y, 0, -1000000, 1000000);
    try {
      const response = await rconCommand(
        agentResourcesCommand({ x, y, radius }),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/agent/observe/entity-prototype"
  ) {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const name = body?.name;
    if (!name || typeof name !== "string") {
      return json(res, 400, { error: "Missing entity name" });
    }
    try {
      const response = await rconCommand(agentEntityPrototypeCommand(name));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      if (data && typeof data === "object" && data.ok === false) {
        return json(res, 400, { error: data?.error || "Unknown entity", data });
      }
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/research") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const technology = body?.technology;
    if (!technology || typeof technology !== "string") {
      return json(res, 400, { error: "Missing technology" });
    }
    try {
      const response = await rconCommand(
        agentResearchStartCommand(technology),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      if (data && typeof data === "object" && data.ok === false) {
        return json(res, 400, { error: data?.error || "Research failed", data });
      }
      return json(res, 200, { ok: true, data });
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
    if (getRunningPid()) {
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
      "--start-server",
      savePath,
      "--server-settings",
      settingsPath,
      "--server-adminlist",
      adminlistPath,
      // Uncomment this and comment --start-server to load the default lab scenario
      // "--start-server-load-scenario",
      // "default_lab_scenario",
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
      detached: true,
    });
    proc.unref();

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
      state.procPid = null;
      clearPidFile();
      state.save = null;
      state.startedAt = null;
      state.usage = { cpuPercent: null, rssBytes: null };
      state.usagePrev = null;
      disconnectRcon();
    });

    state.proc = proc;
    state.procPid = proc.pid ?? null;
    state.save = save;
    state.startedAt = Date.now();
    state.logs = [];
    state.logTail = { stdout: "", stderr: "" };
    state.usage = { cpuPercent: 0, rssBytes: null };
    state.usagePrev = null;
    state.rcon.lastError = null;
    state.alwaysDayPending = rconConfigured();
    if (state.procPid) {
      writePidFile(state.procPid);
    }

    if (state.alwaysDayPending && state.rcon.connected) {
      try {
        await rconCommand(ALWAYS_DAY_COMMAND);
        state.alwaysDayPending = false;
      } catch (err: any) {
        state.rcon.lastError = err?.message || "Failed to set always_day";
      }
    }

    return json(res, 200, statusPayload());
  }

  if (req.method === "POST" && url.pathname === "/api/server/stop") {
    const pid = getRunningPid();
    if (!pid) {
      return json(res, 409, { error: "Server not running" });
    }

    try {
      if (state.proc && !state.proc.killed) {
        state.proc.kill("SIGTERM");
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "Failed to stop server" });
    }
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
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
