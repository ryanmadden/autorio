import { createServer, IncomingMessage, ServerResponse } from "http";
import { spawn } from "child_process";
import fsSync from "fs";
import { promises as fs } from "fs";
import path from "path";
import net from "net";
import { randomUUID } from "crypto";

const PORT = process.env.AUTORIO_PORT
  ? Number(process.env.AUTORIO_PORT)
  : 3000;
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
const MAP_GEN_SETTINGS = path.join(FACTORIO_DIR, "data", "map-gen-settings.json");
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
const API_SCHEMA_VERSION = 2;
const JOB_RETENTION_MS = 60 * 60 * 1000;

function parseRconJson<T>(response: string, errorMessage: string): T {
  try {
    return JSON.parse(response) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

function arrayOrEmpty(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeWorldData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.entities = arrayOrEmpty(data.entities);
  if (data.terrain && typeof data.terrain === "object") {
    data.terrain.rows = arrayOrEmpty(data.terrain.rows);
    for (const row of data.terrain.rows) row.runs = arrayOrEmpty(row?.runs);
  }
  return data;
}

function normalizeResearchData(data: any) {
  if (!data || typeof data !== "object") return data;
  const normalizeTechnology = (technology: any) => {
    if (!technology || typeof technology !== "object") return;
    technology.ingredients = arrayOrEmpty(technology.ingredients);
    technology.prerequisites = arrayOrEmpty(technology.prerequisites);
    technology.missing_prerequisites = arrayOrEmpty(
      technology.missing_prerequisites,
    );
  };
  normalizeTechnology(data.current);
  for (const key of ["queue", "available", "locked", "completed"]) {
    data[key] = arrayOrEmpty(data[key]);
    for (const technology of data[key]) normalizeTechnology(technology);
  }
  return data;
}

function normalizeEntityData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.results = arrayOrEmpty(data.results);
  for (const entity of data.results) {
    entity.inventories = arrayOrEmpty(entity?.inventories);
    entity.fluid_boxes = arrayOrEmpty(entity?.fluid_boxes);
    for (const inventory of entity.inventories) {
      inventory.purposes = arrayOrEmpty(inventory?.purposes);
      inventory.items = arrayOrEmpty(inventory?.items);
    }
    for (const fluidBox of entity.fluid_boxes) {
      fluidBox.connections = arrayOrEmpty(fluidBox?.connections);
    }
  }
  return data;
}

function normalizePrototypeData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.placeable_by = arrayOrEmpty(data.placeable_by);
  data.fluid_boxes = arrayOrEmpty(data.fluid_boxes);
  data.fuel_categories = arrayOrEmpty(data.fuel_categories);
  for (const fluidBox of data.fluid_boxes) {
    fluidBox.pipe_connections = arrayOrEmpty(fluidBox?.pipe_connections);
    for (const connection of fluidBox.pipe_connections) {
      connection.connection_category = arrayOrEmpty(connection?.connection_category);
      connection.positions = arrayOrEmpty(connection?.positions);
    }
  }
  return data;
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

let saveCreationInProgress = false;

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
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { schema_version: API_SCHEMA_VERSION, ...data }
      : { schema_version: API_SCHEMA_VERSION, data };
  const body = JSON.stringify(payload);
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

function normalizeSaveFilename(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing save name");
  }
  const requested = value.trim();
  const base = requested.toLowerCase().endsWith(".zip")
    ? requested.slice(0, -4)
    : requested;
  if (
    !base ||
    base === "." ||
    base === ".." ||
    base.length > 200 ||
    /[\\/\0\r\n]/.test(base)
  ) {
    throw new Error("Invalid save name");
  }
  return `${base}.zip`;
}

async function createSave(save: string): Promise<void> {
  const savePath = path.join(SAVES_DIR, save);
  await fs.mkdir(SAVES_DIR, { recursive: true });
  await fs.access(MAP_GEN_SETTINGS);
  try {
    await fs.access(savePath);
    throw new Error("Save already exists");
  } catch (err: any) {
    if (err?.message === "Save already exists") throw err;
    if (err?.code !== "ENOENT") throw err;
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      FACTORIO_BIN,
      ["--create", savePath, "--map-gen-settings", MAP_GEN_SETTINGS],
      { cwd: FACTORIO_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.once("error", reject);
    proc.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          detail ||
            `Factorio save creation failed${signal ? ` (${signal})` : ` (exit ${code})`}`,
        ),
      );
    });
  });
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

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function luaString(value: string) {
  return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/\"/g, '\\\\"')}"`;
}

type BuildRequest = {
  name: string;
  anchor: { x: number; y: number };
  direction?: number;
};

function agentNativeBuildCommand(item: BuildRequest, dryRun = false): string {
  const direction = item.direction ?? 0;
  const parts = [
    "/sc",
    "local p=game.players[1]",
    "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    `local name=${luaString(item.name)}`,
    `local anchor_x=${Number(item.anchor.x)}`,
    `local anchor_y=${Number(item.anchor.y)}`,
    `local direction=${Number(direction)}`,
    `local dry_run=${dryRun ? "true" : "false"}`,
    "local proto=prototypes.entity[name]",
    "if not proto then done{ok=false,error='unknown_entity',name=name} return end",
    "local place_item=nil local place_count=1 for _,item in pairs(proto.items_to_place_this or {}) do place_item=item.name place_count=item.count or 1 break end",
    "if not place_item then done{ok=false,error='not_player_placeable',name=name} return end",
    "if direction~=0 and direction~=4 and direction~=8 and direction~=12 then done{ok=false,error='invalid_direction',direction=direction} return end",
    "local width=proto.tile_width or math.ceil(proto.collision_box.right_bottom.x-proto.collision_box.left_top.x)",
    "local height=proto.tile_height or math.ceil(proto.collision_box.right_bottom.y-proto.collision_box.left_top.y)",
    "if direction==4 or direction==12 then width,height=height,width end",
    "local x=anchor_x+width/2 local y=anchor_y+height/2",
    "local footprint={min_x=anchor_x,min_y=anchor_y,max_x=anchor_x+width-1,max_y=anchor_y+height-1,width=width,height=height}",
    "local function diagnostics()",
    "local terrain={tile_names={}} local collision={possible_blockers={}} local d={alignment={valid=(anchor_x==math.floor(anchor_x) and anchor_y==math.floor(anchor_y)),required='integer_top_left_tile'},required_footprint=footprint,terrain=terrain,collision=collision,nearest_valid_positions={}}",
    "local dx=x-p.position.x local dy=y-p.position.y d.reachable=dx*dx+dy*dy<=p.build_distance*p.build_distance",
    "local tile_names={} for ty=anchor_y,anchor_y+height-1 do for tx=anchor_x,anchor_x+width-1 do local tile=p.surface.get_tile(tx,ty) if not tile_names[tile.name] then tile_names[tile.name]=true table.insert(terrain.tile_names,tile.name) end end end",
    "local nearby=p.surface.find_entities_filtered{area={{anchor_x,anchor_y},{anchor_x+width,anchor_y+height}}} or {}",
    "for _,e in pairs(nearby) do if e.valid and e~=p.character and e.type~='resource' then table.insert(collision.possible_blockers,{name=e.name,type=e.type,center={x=e.position.x,y=e.position.y}}) end end",
    "for radius=1,6 do for oy=-radius,radius do for ox=-radius,radius do if math.abs(ox)==radius or math.abs(oy)==radius then local ax=anchor_x+ox local ay=anchor_y+oy local cx=ax+width/2 local cy=ay+height/2 if p.surface.can_place_entity{name=name,position={cx,cy},direction=direction,force=p.force,build_check_type=defines.build_check_type.manual} then table.insert(d.nearest_valid_positions,{anchor={x=ax,y=ay},center={x=cx,y=cy}}) if #d.nearest_valid_positions>=8 then return d end end end end end end",
    "return d end",
    "if dry_run then local can_place=p.surface.can_place_entity{name=name,position={x=x,y=y},direction=direction,force=p.force,build_check_type=defines.build_check_type.manual} done{ok=true,can_place=can_place,requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},direction=direction,diagnostics=diagnostics()} return end",
    "local dx=x-p.position.x",
    "local dy=y-p.position.y",
    "if dx*dx+dy*dy > p.build_distance*p.build_distance then done{ok=false,error='out_of_reach',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},diagnostics=diagnostics()} return end",
    "local selected=p.cursor_stack and p.cursor_stack.valid_for_read and p.cursor_stack.name==place_item",
    "if not selected then p.clear_cursor() end",
    "if not selected then local prototype=prototypes.item[place_item] if prototype then selected=p.pipette(prototype,nil,false) end end",
    "if not selected or not p.cursor_stack or not p.cursor_stack.valid_for_read or p.cursor_stack.name~=place_item then done{ok=false,error='missing_item',name=name,required_item={name=place_item,count=place_count}} return end",
    "local params={position={x=x,y=y},direction=direction,build_mode=defines.build_mode.normal,skip_fog_of_war=false}",
    "if not p.can_build_from_cursor(params) then local d=diagnostics() p.clear_cursor() done{ok=false,error='cannot_build',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},direction=direction,diagnostics=d,cursor_cleared=true} return end",
    "p.build_from_cursor(params)",
    "p.clear_cursor()",
    "local entities=p.surface.find_entities_filtered{position={x,y},name=name} or {}",
    "local e=entities[1]",
    "if not e then done{ok=false,error='build_result_not_found',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},cursor_cleared=true} return end",
    "done{ok=true,name=name,placed_with_item=place_item,requested_anchor={x=anchor_x,y=anchor_y},actual_center={x=e.position.x,y=e.position.y},occupied_tiles=footprint,direction=e.direction,cursor_cleared=true}",
  ];
  return parts.join(" ");
}

function agentBuildDestinationCommand(item: BuildRequest): string {
  const direction = item.direction ?? 0;
  return [
    "/sc", "local p=game.players[1]", "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    `local name=${luaString(item.name)}`, `local ax=${item.anchor.x}`, `local ay=${item.anchor.y}`, `local dir=${direction}`,
    "local proto=prototypes.entity[name] if not proto then done{ok=false,error='unknown_entity'} return end",
    "local w=proto.tile_width local h=proto.tile_height if dir==4 or dir==12 then w,h=h,w end local cx=ax+w/2 local cy=ay+h/2",
    "local margin=1 local offsets={{-(w/2+margin),0},{w/2+margin,0},{0,-(h/2+margin)},{0,h/2+margin},{-(w/2+margin),-(h/2+margin)},{w/2+margin,-(h/2+margin)},{-(w/2+margin),h/2+margin},{w/2+margin,h/2+margin}}",
    "local best=nil local best_d=nil for _,o in pairs(offsets) do local tx=cx+o[1] local ty=cy+o[2] local pos=p.surface.find_non_colliding_position('character',{tx,ty},0.75,0.1) if pos then local reach_dx=pos.x-cx local reach_dy=pos.y-cy if reach_dx*reach_dx+reach_dy*reach_dy<=p.build_distance*p.build_distance then local dx=pos.x-p.position.x local dy=pos.y-p.position.y local d=dx*dx+dy*dy if not best_d or d<best_d then best=pos best_d=d end end end end",
    "if not best then done{ok=false,error='no_reachable_staging_position'} return end done{ok=true,position=best,center={x=cx,y=cy}}",
  ].join(" ");
}

function agentMapCommand(params: { x: number; y: number; radius: number }): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v) if v==nil then return 'null' end if type(v)=='string' then return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"' end return tostring(v) end",
    `local min_x=${minX}`, `local max_x=${maxX}`, `local min_y=${minY}`, `local max_y=${maxY}`,
    "local chunks={} local symbols={}",
    "local cminx=math.floor(min_x/32) local cmaxx=math.floor(max_x/32) local cminy=math.floor(min_y/32) local cmaxy=math.floor(max_y/32)",
    "for cy=cminy,cmaxy do for cx=cminx,cmaxx do",
    "local charted=force.is_chunk_charted(s,{x=cx,y=cy})",
    "table.insert(chunks,'{\"x\":'..cx..',\"y\":'..cy..',\"charted\":'..tostring(charted)..'}')",
    "if charted then local ents=s.find_entities_filtered{area={{cx*32,cy*32},{cx*32+32,cy*32+32}}} or {} for i=1,#ents do local e=ents[i] if e.valid and (e.type=='resource' or e.force==force) then table.insert(symbols,'{\"name\":'..esc(e.name)..',\"type\":'..esc(e.type)..',\"x\":'..math.floor(e.position.x)..',\"y\":'..math.floor(e.position.y)..'}') end end end",
    "end end",
    "rcon.print('{\"window\":{\"min_x\":'..min_x..',\"min_y\":'..min_y..',\"max_x\":'..max_x..',\"max_y\":'..max_y..'},\"chunks\":['..table.concat(chunks,',')..'],\"symbols\":['..table.concat(symbols,',')..']}')",
  ].join(" ");
}

function agentChartedResourcesCommand(params: { x: number; y: number; radius: number }): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  return [
    "/sc", "local s=game.surfaces[1]", "local force=game.forces.player or game.forces[1]",
    `local center_x=${params.x}`, `local center_y=${params.y}`, `local min_x=${minX}`, `local max_x=${maxX}`, `local min_y=${minY}`, `local max_y=${maxY}`,
    "local found=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}},type='resource'} or {} local cells={} local total=0",
    "for _,e in pairs(found) do local x=math.floor(e.position.x) local y=math.floor(e.position.y) if force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) then local key=e.name..':'..x..':'..y cells[key]={name=e.name,x=x,y=y,amount=e.amount or 0} total=total+1 end end",
    "local visited={} local patches={} local neighbours={{-1,-1},{0,-1},{1,-1},{-1,0},{1,0},{-1,1},{0,1},{1,1}}",
    "for key,start in pairs(cells) do if not visited[key] then local queue={start} visited[key]=true local head=1 local count=0 local amount=0 local sum_x=0 local sum_y=0 local minpx=start.x local maxpx=start.x local minpy=start.y local maxpy=start.y while head<=#queue do local cell=queue[head] head=head+1 count=count+1 amount=amount+cell.amount sum_x=sum_x+cell.x sum_y=sum_y+cell.y minpx=math.min(minpx,cell.x) maxpx=math.max(maxpx,cell.x) minpy=math.min(minpy,cell.y) maxpy=math.max(maxpy,cell.y) for _,o in pairs(neighbours) do local nk=cell.name..':'..(cell.x+o[1])..':'..(cell.y+o[2]) local next_cell=cells[nk] if next_cell and not visited[nk] then visited[nk]=true table.insert(queue,next_cell) end end end local cx=sum_x/count local cy=sum_y/count table.insert(patches,{resource=start.name,tile_count=count,amount=amount,center={x=cx,y=cy},bounds={min_x=minpx,min_y=minpy,max_x=maxpx,max_y=maxpy},distance=math.sqrt((cx-center_x)^2+(cy-center_y)^2)}) end end",
    "table.sort(patches,function(a,b) if a.distance==b.distance then return a.resource<b.resource end return a.distance<b.distance end) local patch_count=#patches local nearest={} for _,patch in ipairs(patches) do if not nearest[patch.resource] then nearest[patch.resource]=patch end end while #patches>200 do table.remove(patches) end",
    "local shoreline={} local shoreline_radius=math.min(128,math.max(math.abs(max_x-center_x),math.abs(max_y-center_y))) local shore_min_x=center_x-shoreline_radius local shore_max_x=center_x+shoreline_radius local shore_min_y=center_y-shoreline_radius local shore_max_y=center_y+shoreline_radius local dirs={{0,-1,0,'north'},{1,0,4,'east'},{0,1,8,'south'},{-1,0,12,'west'}} for y=shore_min_y,shore_max_y do for x=shore_min_x,shore_max_x do if force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) then local land=s.get_tile(x,y) if not string.find(land.name,'water',1,true) then for _,d in pairs(dirs) do local water=s.get_tile(x+d[1],y+d[2]) if string.find(water.name,'water',1,true) then table.insert(shoreline,{land_tile={x=x,y=y,name=land.name},water_tile={x=x+d[1],y=y+d[2],name=water.name},facing=d[4],direction=d[3],distance=math.sqrt((x-center_x)^2+(y-center_y)^2)}) end end end end end end table.sort(shoreline,function(a,b) return a.distance<b.distance end) while #shoreline>64 do table.remove(shoreline) end",
    "rcon.print(helpers.table_to_json{patches=patches,patch_count=patch_count,patches_truncated=patch_count>#patches,nearest_by_resource=nearest,shoreline_candidates=shoreline,shoreline_scan_radius=shoreline_radius,total_resource_tiles=total,charted_only=true})",
  ].join(" ");
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
    "local charted=force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)})",
    "if charted then local t=s.get_tile(x,y) table.insert(tiles_out,'{\"x\":'..x..',\"y\":'..y..',\"name\":'..esc(t.name)..'}') tiles_included=tiles_included+1 end",
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
    "local charted=force.is_chunk_charted(s,{x=math.floor(e.position.x/32),y=math.floor(e.position.y/32)})",
    "if charted then",
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

function agentCompactWorldCommand(params: {
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
  return [
    "/sc", "local s=game.surfaces[1]", "local force=game.forces.player or game.forces[1]",
    `local min_x=${minX}`, `local max_x=${maxX}`, `local min_y=${minY}`, `local max_y=${maxY}`,
    `local include_tiles=${params.includeTiles ? "true" : "false"}`, `local include_entities=${params.includeEntities ? "true" : "false"}`,
    "local rows={} local tile_total=0 local tile_included=0 if include_tiles then for y=min_y,max_y do local runs={} local current=nil for x=min_x,max_x do tile_total=tile_total+1 local charted=force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) local name=charted and s.get_tile(x,y).name or 'uncharted' if charted then tile_included=tile_included+1 end if current and current.name==name then current.length=current.length+1 else current={x=x,length=1,name=name} table.insert(runs,current) end end table.insert(rows,{y=y,runs=runs}) end end",
    "local entities={} local entity_total=0 if include_entities then local found=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}} or {} for _,e in pairs(found) do if force.is_chunk_charted(s,{x=math.floor(e.position.x/32),y=math.floor(e.position.y/32)}) then entity_total=entity_total+1 local health=nil pcall(function() health=e.health end) local cb=e.prototype.collision_box table.insert(entities,{name=e.name,type=e.type,center={x=e.position.x,y=e.position.y},occupied_tile={x=math.floor(e.position.x),y=math.floor(e.position.y)},collision_bounds={left=e.position.x+cb.left_top.x,top=e.position.y+cb.left_top.y,right=e.position.x+cb.right_bottom.x,bottom=e.position.y+cb.right_bottom.y},direction=e.direction,force=e.force and e.force.name or nil,health=health}) end end end",
    "rcon.print(helpers.table_to_json{window={min_x=min_x,min_y=min_y,max_x=max_x,max_y=max_y},terrain={encoding='rle_rows',rows=rows},entities=entities,counts={tiles_total=tile_total,tiles_included=tile_included,entities_included=entity_total},charted_only=true})",
  ].join(" ");
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
    "local stack=inv[i]",
    "if stack and stack.valid_for_read then",
    "inv_total=inv_total+1",
    "if inv_included < inv_limit then",
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
    "local cursor='null'",
    "if player.cursor_stack and player.cursor_stack.valid_for_read then cursor='{\"name\":'..esc(player.cursor_stack.name)..',\"count\":'..player.cursor_stack.count..'}' end",
    "table.insert(pf,'\"cursor\":'..cursor)",
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

function agentResearchCommand(params: {
  availableLimit: number;
  lockedLimit: number;
  completedLimit: number;
}): string {
  return [
    "/sc", "local force=game.forces.player or game.forces[1]",
    `local available_limit=${params.availableLimit}`, `local locked_limit=${params.lockedLimit}`, `local completed_limit=${params.completedLimit}`,
    "local function descriptor(tech,status)",
    "local ingredients={} for _,ingredient in pairs(tech.research_unit_ingredients or {}) do table.insert(ingredients,{name=ingredient.name,amount=ingredient.amount}) end table.sort(ingredients,function(a,b) return a.name<b.name end)",
    "local prerequisites={} local missing={} for name,p in pairs(tech.prerequisites or {}) do table.insert(prerequisites,name) if not p.researched then table.insert(missing,name) end end table.sort(prerequisites) table.sort(missing)",
    "return {name=tech.name,level=tech.level,status=status,enabled=tech.enabled,researched=tech.researched,unit_count=tech.research_unit_count,unit_time_seconds=tech.research_unit_energy/60,unit_energy_ticks=tech.research_unit_energy,ingredients=ingredients,prerequisites=prerequisites,missing_prerequisites=missing,saved_progress=tech.saved_progress}",
    "end",
    "local available={} local locked={} local completed={} local counts={available=0,locked=0,completed=0}",
    "local names={} for name,_ in pairs(force.technologies) do table.insert(names,name) end table.sort(names)",
    "for _,name in ipairs(names) do local tech=force.technologies[name] local has_units=#(tech.research_unit_ingredients or {})>0 local missing=false for _,p in pairs(tech.prerequisites or {}) do if not p.researched then missing=true break end end",
    "if tech.researched then counts.completed=counts.completed+1 if #completed<completed_limit then table.insert(completed,descriptor(tech,'completed')) end",
    "elseif tech.enabled and has_units and not missing then counts.available=counts.available+1 if #available<available_limit then table.insert(available,descriptor(tech,'available')) end",
    "else counts.locked=counts.locked+1 if #locked<locked_limit then table.insert(locked,descriptor(tech,'locked')) end end end",
    "local queue={} if force.research_queue then for _,tech in ipairs(force.research_queue) do table.insert(queue,descriptor(tech,'queued')) end end",
    "local current=nil if force.current_research then current=descriptor(force.current_research,'researching') current.progress=force.research_progress end",
    "rcon.print(helpers.table_to_json{current=current,queue=queue,available=available,locked=locked,completed=completed,counts={available_total=counts.available,available_included=#available,locked_total=counts.locked,locked_included=#locked,completed_total=counts.completed,completed_included=#completed}})",
  ].join(" ");
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

type EntityTarget = { x: number; y: number; kind?: "resource" | "entity"; name?: string };

function agentMineCommand(targets: EntityTarget[]): string {
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
    "local function find_entity(x,y,kind,wanted_name) local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.minable and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' and (not kind or (kind=='resource' and cand.type=='resource') or (kind=='entity' and cand.type~='resource')) and (not wanted_name or cand.name==wanted_name) then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) local score=(cand.type=='resource' and 0 or 100)+(wanted_name and 1000 or 0)-dx*dx-dy*dy table.insert(candidates,{entity=cand,score=score,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end) return candidates[1] and candidates[1].entity or nil end",
    "local function ensure_reach(entity)",
    "if not player.character then return false,'no_character' end",
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
    "local function mine(x,y,kind,wanted_name)",
    "local e=find_entity(x,y,kind,wanted_name)",
    "if not e then return {x=x,y=y,requested_tile={x=x,y=y},ok=false,error=kind=='resource' and 'no_resource' or 'no_entity'} end",
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
    parts.push(`table.insert(results,mine(${target.x},${target.y},${target.kind ? luaString(target.kind) : "nil"},${target.name ? luaString(target.name) : "nil"}))`);
  }
  parts.push(
    "local out={}",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.name then entry=entry..',\"name\":'..esc(r.name) end",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "if r.mined_count then entry=entry..',\"mined_count\":'..esc(r.mined_count) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "local results_json='['..table.concat(out,',')..']'",
    "rcon.print('{\"results\":'..results_json..'}')",
  );
  return parts.join(" ");
}

function agentMineProbeCommand(target: EntityTarget): string {
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
    `local kind=${target.kind ? luaString(target.kind) : "nil"}`,
    `local wanted_name=${target.name ? luaString(target.name) : "nil"}`,
    "local function find_entity(x,y) local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.minable and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' and (not kind or (kind=='resource' and cand.type=='resource') or (kind=='entity' and cand.type~='resource')) and (not wanted_name or cand.name==wanted_name) then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) local score=(cand.type=='resource' and 0 or 100)+(wanted_name and 1000 or 0)-dx*dx-dy*dy table.insert(candidates,{entity=cand,score=score,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end) return candidates[1] and candidates[1].entity or nil end",
    `local target_x=${target.x}`,
    `local target_y=${target.y}`,
    "local e=find_entity(target_x,target_y)",
    "if not e then rcon.print(helpers.table_to_json{error=kind=='resource' and 'no_resource' or 'no_entity'}) return end",
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

function agentInteractionDestinationCommand(target: EntityTarget) {
  return [
    "/sc", "local s=game.surfaces[1]", "local p=game.players[1]", "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    `local x=${target.x}`, `local y=${target.y}`, `local kind=${target.kind ? luaString(target.kind) : "nil"}`, `local wanted_name=${target.name ? luaString(target.name) : "nil"}`,
    "local found=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,candidate in pairs(found) do if candidate.valid and candidate~=p.character and candidate.type~='item-entity' and candidate.type~='corpse' and (not kind or (kind=='resource' and candidate.type=='resource') or (kind=='entity' and candidate.type~='resource')) and (not wanted_name or candidate.name==wanted_name) then local dx=candidate.position.x-(x+0.5) local dy=candidate.position.y-(y+0.5) local score=(candidate.type=='resource' and 0 or 100)+(wanted_name and 1000 or 0)-dx*dx-dy*dy table.insert(candidates,{entity=candidate,score=score,key=candidate.name..':'..candidate.position.x..':'..candidate.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end) local e=candidates[1] and candidates[1].entity or nil if not e then done{ok=false,error=kind=='resource' and 'no_resource' or 'no_entity'} return end",
    "if p.can_reach_entity(e) then done{ok=true,position={x=p.position.x,y=p.position.y},entity={name=e.name,center={x=e.position.x,y=e.position.y}}} return end",
    "local pos=s.find_non_colliding_position('character',e.position,math.max(1,p.reach_distance-0.25),0.1) if not pos then done{ok=false,error='no_reachable_staging_position'} return end",
    "done{ok=true,position={x=pos.x,y=pos.y},entity={name=e.name,center={x=e.position.x,y=e.position.y}}}",
  ].join(" ");
}

async function moveNearEntity(target: EntityTarget) {
  const destination = parseRconJson<any>(
    await rconCommand(agentInteractionDestinationCommand(target)),
    "RCON interaction destination returned invalid JSON",
  );
  if (!destination?.ok) return destination;
  const movement = await movePlayerTo(
    Number(destination.position.x),
    Number(destination.position.y),
  );
  return { ...movement, entity: destination.entity };
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
    "local function find_entity(x,y) local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) local score=(cand.type=='resource' and 0 or 100)-dx*dx-dy*dy table.insert(candidates,{entity=cand,score=score,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end) return candidates[1] and candidates[1].entity or nil end",
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

function agentMoveStepCommand(params: {
  x: number;
  y: number;
  direction: number;
}): string {
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player or not player.character then rcon.print(\'{"ok":false,"error":"no_character"}\') return end',
    `local x=${params.x}`,
    `local y=${params.y}`,
    `local direction=${params.direction}`,
    "local pos=s.find_non_colliding_position('character',{x=x,y=y},0.75,0.1)",
    "if not pos then rcon.print('{\"ok\":false,\"error\":\"blocked\"}') return end",
    "if math.abs(pos.x-x)>0.76 or math.abs(pos.y-y)>0.76 then rcon.print('{\"ok\":false,\"error\":\"blocked\"}') return end",
    "player.teleport(pos)",
    "player.character.direction=direction",
    "rcon.print('{\"ok\":true,\"x\":'..pos.x..',\"y\":'..pos.y..'}')",
  ].join(" ");
}

function directionForVector(dx: number, dy: number) {
  if (dx === 0 && dy === 0) return 0;
  const octant = Math.round(Math.atan2(dx, -dy) / (Math.PI / 4));
  return ((octant % 8) + 8) % 8 * 2;
}

async function movePlayerTo(targetX: number, targetY: number) {
  const probe = parseRconJson<any>(
    await rconCommand(agentPlayerPositionCommand()),
    "RCON player-position probe returned invalid JSON",
  );
  const start = probe?.player;
  if (!start || !Number.isFinite(start.x) || !Number.isFinite(start.y)) {
    return { ok: false, error: probe?.error || "probe_failed" };
  }
  const distance = Math.hypot(targetX - start.x, targetY - start.y);
  const steps = Math.max(1, Math.ceil(distance / 0.75));
  const stepDelayMs = walkDelayMs(distance) / steps;
  let movedX = start.x;
  let movedY = start.y;
  for (let step = 1; step <= steps; step++) {
    if (stepDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    const fraction = step / steps;
    const nextX = start.x + (targetX - start.x) * fraction;
    const nextY = start.y + (targetY - start.y) * fraction;
    const data = parseRconJson<any>(
      await rconCommand(
        agentMoveStepCommand({
          x: nextX,
          y: nextY,
          direction: directionForVector(nextX - movedX, nextY - movedY),
        }),
      ),
      "RCON move step returned invalid JSON",
    );
    if (!data?.ok) {
      return {
        ok: false,
        error: data?.error || "blocked",
        movement: { distance, duration_ms: Math.round(walkDelayMs(distance) * (step - 1) / steps), final_position: { x: movedX, y: movedY } },
      };
    }
    movedX = data.x;
    movedY = data.y;
  }
  return {
    ok: true,
    movement: { distance, duration_ms: walkDelayMs(distance), final_position: { x: movedX, y: movedY } },
  };
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
    "return false,'out_of_reach'",
    "end",
    "local results={}",
    "local function rotate(x,y)",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='character' and cand.type~='resource' and cand.type~='item-entity' and cand.type~='corpse' then table.insert(candidates,{entity=cand,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) return a.key<b.key end) local e=candidates[1] and candidates[1].entity or nil",
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
    "return false,'out_of_reach'",
    "end",
    "local results={}",
    "local function set_recipe(x,y,recipe)",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='character' and cand.type~='resource' and cand.type~='item-entity' and cand.type~='corpse' then table.insert(candidates,{entity=cand,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) return a.key<b.key end) local e=candidates[1] and candidates[1].entity or nil",
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
    "if not player.force.recipes[recipe] then rcon.print('{\"recipe\":'..esc(recipe)..',\"count\":'..esc(count)..',\"ok\":false,\"error\":\"Unknown recipe\"}') return end",
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
    "return false,'out_of_reach'",
    "end",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='resource' and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) table.insert(candidates,{entity=cand,score=-(dx*dx+dy*dy),key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end)",
    "local e=candidates[1] and candidates[1].entity or nil",
    'if not e then rcon.print(\'{"ok":false,"error":"no_entity"}\') return end',
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then rcon.print('{\"ok\":false,\"error\":'..esc(reach_err or 'out_of_reach')..'}') return end",
    "local available=player.get_item_count(item) or 0",
    "if available < count then rcon.print(helpers.table_to_json{ok=false,error='count too high: requested '..count..' but only '..available..' available',available=available,requested=count,entity=e.name}) return end",
    "local removed=player.remove_item{name=item,count=count}",
    "local inserted=e.insert{name=item,count=removed}",
    "if inserted < removed then player.insert{name=item,count=removed-inserted} end",
    "local out={}",
    "table.insert(out,'\"ok\":'..tostring(inserted==count))",
    "table.insert(out,'\"entity\":'..esc(e.name))",
    "table.insert(out,'\"removed\":'..esc(removed))",
    "table.insert(out,'\"inserted\":'..esc(inserted))",
    "if inserted<count then table.insert(out,'\"error\":'..esc('entity capacity too low: requested '..count..' but inserted '..inserted)) end",
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
    "return false,'out_of_reach'",
    "end",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='resource' and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) table.insert(candidates,{entity=cand,score=-(dx*dx+dy*dy),key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end)",
    "local e=candidates[1] and candidates[1].entity or nil",
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
    "rcon.print(helpers.table_to_json{ok=true,entity=e.name,removed=0,inserted=0})",
    "return",
    "end",
    "local removed=e.remove_item{name=item,count=count}",
    "local inserted=player.insert{name=item,count=removed}",
    "if inserted < removed then e.insert{name=item,count=removed-inserted} end",
    "local out={}",
    "table.insert(out,'\"ok\":'..tostring(inserted==count))",
    "table.insert(out,'\"entity\":'..esc(e.name))",
    "table.insert(out,'\"removed\":'..esc(removed))",
    "table.insert(out,'\"inserted\":'..esc(inserted))",
    "if inserted<count then table.insert(out,'\"error\":'..esc('player inventory capacity too low: requested '..count..' but inserted '..inserted)) end",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentObserveEntityCommand(
  targets: Array<{ x: number; y: number; kind?: string; name?: string }>,
): string {
  const parts = [
    "/sc", "local s=game.surfaces[1]", "local force=game.forces.player or game.forces[1]", "local results={}",
    "local function find_entity(x,y,kind,wanted_name) local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' and (not kind or (kind=='resource' and cand.type=='resource') or (kind=='entity' and cand.type~='resource')) and (not wanted_name or cand.name==wanted_name) then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) local score=(cand.type=='resource' and 0 or 100)+(wanted_name and 1000 or 0)-dx*dx-dy*dy table.insert(candidates,{entity=cand,score=score,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end) return candidates[1] and candidates[1].entity or nil end",
    "local function items(inv) local out={} if inv and inv.valid then for i=1,#inv do local stack=inv[i] if stack and stack.valid_for_read then table.insert(out,{slot=i,name=stack.name,count=stack.count}) end end end return out end",
    "local function observe(x,y,kind,wanted_name)",
    "if not force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) then return {requested_tile={x=x,y=y},ok=false,error='uncharted'} end",
    "local e=find_entity(x,y,kind,wanted_name) if not e then return {requested_tile={x=x,y=y},ok=false,error=kind=='resource' and 'no_resource' or 'no_entity'} end",
    "local status=nil local ok_status,value=pcall(function() return e.status end) if ok_status and value then local names={} for k,v in pairs(defines.entity_status) do names[v]=k end status=names[value] or tostring(value) end",
    "local health=nil pcall(function() health=e.health end) local max_health=nil pcall(function() max_health=e.prototype.max_health end) local energy=nil pcall(function() energy=e.energy end)",
    "local inventories={} local seen={} local function add_inventory(purpose,inv,index) if not inv or not inv.valid then return end local resolved_index=index pcall(function() resolved_index=resolved_index or inv.index end) local existing=resolved_index and seen[resolved_index] or nil if existing then local already=false for _,known in pairs(existing.purposes) do if known==purpose then already=true break end end if not already then table.insert(existing.purposes,purpose) end return end local factorio_name=nil pcall(function() factorio_name=inv.name end) local entry={purposes={purpose},factorio_name=factorio_name,index=resolved_index,items=items(inv)} if resolved_index then seen[resolved_index]=entry end table.insert(inventories,entry) end",
    "local ok,inv=pcall(function() return e.get_fuel_inventory() end) if ok then add_inventory('fuel',inv) end ok,inv=pcall(function() return e.get_burnt_result_inventory() end) if ok then add_inventory('burnt_result',inv) end if e.type=='furnace' or e.type=='assembling-machine' or e.type=='rocket-silo' then ok,inv=pcall(function() return e.get_output_inventory() end) if ok then add_inventory('output',inv) end end ok,inv=pcall(function() return e.get_module_inventory() end) if ok then add_inventory('modules',inv) end",
    "local max_index=0 pcall(function() local value=e.get_max_inventory_index() if type(value)=='number' then max_index=value end end) for index=1,max_index do local got=nil pcall(function() got=e.get_inventory(index) end) if got and got.valid then local n=nil pcall(function() n=e.get_inventory_name(index) end) add_inventory(n or 'inventory',got,index) end end",
    "local fluid_boxes={} local fb_count=0 pcall(function() fb_count=#e.fluidbox end) for index=1,fb_count do local fluid=nil pcall(function() fluid=e.fluidbox[index] end) local capacity=nil pcall(function() capacity=e.fluidbox.get_capacity(index) end) local filter=nil pcall(function() local f=e.fluidbox.get_filter(index) filter=f and f.name or nil end) local production_type=nil pcall(function() local fp=e.fluidbox.get_prototype(index) if fp and fp.production_type then production_type=fp.production_type end end) local connections={} pcall(function() for _,c in pairs(e.fluidbox.get_pipe_connections(index) or {}) do local owner=c.target and c.target.owner or nil table.insert(connections,{connection_type=c.connection_type,flow_direction=c.flow_direction,position={x=c.position.x,y=c.position.y},target_position={x=c.target_position.x,y=c.target_position.y},target=owner and {name=owner.name,center={x=owner.position.x,y=owner.position.y}} or nil,target_fluidbox_index=c.target_fluidbox_index,target_pipe_connection_index=c.target_pipe_connection_index}) end end) table.insert(fluid_boxes,{index=index,production_type=production_type,filter=filter,capacity=capacity,fluid=fluid and {name=fluid.name,amount=fluid.amount,temperature=fluid.temperature} or nil,connections=connections}) end",
    "local recipe=nil pcall(function() local r=e.get_recipe() recipe=r and r.name or nil end) local drop_position=nil pcall(function() drop_position=e.drop_position end) local drop_target=nil pcall(function() local t=e.drop_target drop_target=t and {name=t.name,center={x=t.position.x,y=t.position.y}} or nil end)",
    "return {requested_tile={x=x,y=y},ok=true,name=e.name,type=e.type,center={x=e.position.x,y=e.position.y},occupied_tile={x=math.floor(e.position.x),y=math.floor(e.position.y)},direction=e.direction,status=status,health=health,max_health=max_health,energy=energy,recipe=recipe,inventories=inventories,fluid_boxes=fluid_boxes,drop_position=drop_position and {x=drop_position.x,y=drop_position.y} or nil,drop_target=drop_target} end",
  ];
  for (const target of targets) {
    parts.push(`table.insert(results,observe(${target.x},${target.y},${target.kind ? luaString(target.kind) : "nil"},${target.name ? luaString(target.name) : "nil"}))`);
  }
  parts.push("rcon.print(helpers.table_to_json{results=results})");
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
  return [
    "/sc", `local name=${luaString(name)}`, "local proto=prototypes.entity[name]",
    "if not proto then rcon.print(helpers.table_to_json{ok=false,error='unknown_entity',name=name}) return end",
    "local function box(value) if not value then return nil end return {left_top={x=value.left_top.x,y=value.left_top.y},right_bottom={x=value.right_bottom.x,y=value.right_bottom.y}} end",
    "local fluid_boxes={} local direction_names={[0]='north',[4]='east',[8]='south',[12]='west'} local direction_vectors={[0]={x=0,y=-1},[4]={x=1,y=0},[8]={x=0,y=1},[12]={x=-1,y=0}} for index,fb in pairs(proto.fluidbox_prototypes or {}) do local connections={} for _,pc in pairs(fb.pipe_connections or {}) do local positions={} for orientation,pos in pairs(pc.positions or {}) do local actual_direction=((pc.direction or 0)+(orientation-1)*4)%16 local vector=direction_vectors[actual_direction] table.insert(positions,{orientation_index=orientation,orientation_name=({'north','east','south','west'})[orientation],connection_position={x=pos.x,y=pos.y},connection_direction=direction_names[actual_direction],compatible_neighbor_position=vector and {x=pos.x+vector.x,y=pos.y+vector.y} or nil}) end table.insert(connections,{connection_type=pc.connection_type,flow_direction=pc.flow_direction,connection_category=pc.connection_category,positions=positions,max_underground_distance=pc.max_underground_distance}) end table.insert(fluid_boxes,{index=index,production_type=fb.production_type,filter=fb.filter and fb.filter.name or nil,minimum_temperature=fb.minimum_temperature,maximum_temperature=fb.maximum_temperature,pipe_connections=connections}) end",
    "table.sort(fluid_boxes,function(a,b) return a.index<b.index end)",
    "local function safe(read) local ok,value=pcall(read) if ok then return value end return nil end local electric=safe(function() return proto.electric_energy_source_prototype end) local burner=safe(function() return proto.burner_prototype end) local fluid=safe(function() return proto.fluid_energy_source_prototype end) local heat=safe(function() return proto.heat_energy_source_prototype end)",
    "local energy_type='none' if electric then energy_type='electric' elseif burner then energy_type='burner' elseif fluid then energy_type='fluid' elseif heat then energy_type='heat' end",
    "local fuel_categories={} if burner then for category,_ in pairs(burner.fuel_categories or {}) do table.insert(fuel_categories,category) end table.sort(fuel_categories) end",
    "local placeable_by={} for _,item in pairs(proto.items_to_place_this or {}) do table.insert(placeable_by,{name=item.name,count=item.count}) end",
    "local max_health=safe(function() return proto.max_health end) local flags=safe(function() return proto.flags end) or {}",
    "local out={ok=true,name=name,type=proto.type,tile_size={width=proto.tile_width,height=proto.tile_height},center_alignment={x=(proto.tile_width%2==0) and 'integer' or 'half_tile',y=(proto.tile_height%2==0) and 'integer' or 'half_tile'},collision_box=box(proto.collision_box),selection_box=box(proto.selection_box),rotatable=not flags['not-rotatable'],placeable_by=placeable_by,fluid_boxes=fluid_boxes,energy_source=energy_type,fuel_categories=fuel_categories,max_health=max_health}",
    "rcon.print(helpers.table_to_json(out))",
  ].join(" ");
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

async function rconCommand(command: string, timeoutMs = 3000): Promise<string> {
  if (!state.rcon.connected) throw new Error("RCON not connected");
  const id = state.rcon.nextId++;
  return rconSendInternal(id, 2, command, timeoutMs);
}

type JobAction =
  | "build"
  | "mine"
  | "move"
  | "rotate"
  | "set-recipe"
  | "research"
  | "craft"
  | "insert"
  | "extract";

type ActionJob = {
  id: string;
  action: JobAction;
  idempotency_key: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total: number;
  completed: number;
  results: any[];
  error: string | null;
  cancel_requested: boolean;
  payload: any;
};

const jobs = new Map<string, ActionJob>();
const jobKeys = new Map<string, string>();
let actionQueue: Promise<void> = Promise.resolve();

const actionPaths: Record<JobAction, string> = {
  build: "/api/agent/act/build",
  mine: "/api/agent/act/mine",
  move: "/api/agent/act/move",
  rotate: "/api/agent/act/rotate",
  "set-recipe": "/api/agent/act/set-recipe",
  research: "/api/agent/act/research",
  craft: "/api/agent/act/craft",
  insert: "/api/agent/act/insert",
  extract: "/api/agent/act/extract",
};

function splitJobPayload(action: JobAction, payload: any): any[] {
  if (action === "build") return (Array.isArray(payload?.entities) ? payload.entities : []).map((entity: any) => ({ entities: [entity] }));
  if (["mine", "move", "rotate", "set-recipe"].includes(action)) {
    return (Array.isArray(payload?.targets) ? payload.targets : []).map((target: any) => ({ targets: [target] }));
  }
  return [payload ?? {}];
}

function publicJob(job: ActionJob) {
  return {
    job_id: job.id,
    action: job.action,
    idempotency_key: job.idempotency_key,
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    progress: { completed: job.completed, total: job.total },
    results: job.results,
    error: job.error,
    cancel_requested: job.cancel_requested,
  };
}

async function runActionJob(job: ActionJob) {
  if (job.cancel_requested) {
    job.status = "cancelled";
    job.completed_at = new Date().toISOString();
    return;
  }
  job.status = "running";
  job.started_at = new Date().toISOString();
  const items = splitJobPayload(job.action, job.payload);
  try {
    for (const payload of items) {
      if (job.cancel_requested) {
        job.status = "cancelled";
        break;
      }
      const response = await fetch(`http://127.0.0.1:${PORT}${actionPaths[job.action]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Autorio-Internal": "job" },
        body: JSON.stringify(payload),
      });
      const envelope = await response.json() as any;
      const data = envelope?.data;
      let result = data?.results?.[0] ?? data ?? envelope;
      if (!response.ok) {
        result = { ok: false, error: envelope?.error || `HTTP ${response.status}`, detail: result };
      }
      job.results.push(result);
      job.completed++;
    }
    if (job.status !== "cancelled") job.status = "completed";
  } catch (err: any) {
    job.status = "failed";
    job.error = err?.message || "Action job failed";
  } finally {
    job.completed_at = new Date().toISOString();
  }
}

function queueActionJob(action: JobAction, payload: any, idempotencyKey: string | null) {
  const scopedKey = idempotencyKey ? `${action}:${idempotencyKey}` : null;
  if (idempotencyKey) {
    const existingId = jobKeys.get(scopedKey!);
    const existing = existingId ? jobs.get(existingId) : null;
    if (existing) return existing;
  }
  const items = splitJobPayload(action, payload);
  const job: ActionJob = {
    id: randomUUID(),
    action,
    idempotency_key: idempotencyKey,
    status: "queued",
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    total: items.length,
    completed: 0,
    results: [],
    error: null,
    cancel_requested: false,
    payload,
  };
  jobs.set(job.id, job);
  if (scopedKey) jobKeys.set(scopedKey, job.id);
  actionQueue = actionQueue.then(() => runActionJob(job), () => runActionJob(job));
  return job;
}

setInterval(() => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.completed_at && Date.parse(job.completed_at) < cutoff) {
      jobs.delete(id);
      if (job.idempotency_key) jobKeys.delete(`${job.action}:${job.idempotency_key}`);
    }
  }
}, 60_000);

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

  if (req.method === "POST" && url.pathname === "/api/agent/jobs") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
    if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
    const action = body?.action as JobAction;
    if (!action || !(action in actionPaths)) {
      return json(res, 400, { error: "Unknown job action", allowed_actions: Object.keys(actionPaths) });
    }
    if (splitJobPayload(action, body?.payload).length === 0) {
      return json(res, 400, { error: "Action payload contains no work" });
    }
    const keyHeader = req.headers["idempotency-key"];
    const idempotencyKey =
      (typeof keyHeader === "string" ? keyHeader : null) ??
      (typeof body?.idempotency_key === "string" ? body.idempotency_key : null);
    const job = queueActionJob(action, body?.payload, idempotencyKey);
    return json(res, 202, publicJob(job));
  }

  const jobMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: "Job not found" });
    return json(res, 200, publicJob(job));
  }
  const cancelJobMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/cancel$/);
  if (cancelJobMatch && req.method === "POST") {
    const job = jobs.get(cancelJobMatch[1]);
    if (!job) return json(res, 404, { error: "Job not found" });
    if (job.status === "queued" || job.status === "running") job.cancel_requested = true;
    return json(res, 202, publicJob(job));
  }

  if (
    url.pathname.startsWith("/api/agent/act/") &&
    req.headers["x-autorio-internal"] !== "job"
  ) {
    return json(res, 409, {
      error: "Actions must be submitted through POST /api/agent/jobs",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/saves") {
    try {
      const saves = await listSaves();
      return json(res, 200, { saves });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "Failed to list saves" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/saves") {
    if (saveCreationInProgress) {
      return json(res, 409, { error: "A save is already being created" });
    }
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }

    let save: string;
    try {
      save = normalizeSaveFilename(body?.name);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid save name" });
    }

    saveCreationInProgress = true;
    try {
      await createSave(save);
      return json(res, 201, { ok: true, save });
    } catch (err: any) {
      const message = err?.message || "Failed to create save";
      const status = message === "Save already exists" ? 409 : 500;
      return json(res, status, { error: message });
    } finally {
      saveCreationInProgress = false;
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
    const includeTiles = include.includes("terrain");
    const includeEntities = include.includes("entities");
    const radius = clampInt(window.radius, AGENT_DEFAULT_RADIUS, 1, 200);
    const x = clampInt(window.x, 0, -1000000, 1000000);
    const y = clampInt(window.y, 0, -1000000, 1000000);
    try {
      const response = await rconCommand(
        agentCompactWorldCommand({
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
      data = normalizeWorldData(data);
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

  if (req.method === "POST" && url.pathname === "/api/agent/observe/map") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
    if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
    const window = body?.window || {};
    const x = clampInt(window.x, 0, -1000000, 1000000);
    const y = clampInt(window.y, 0, -1000000, 1000000);
    const radius = clampInt(window.radius, 48, 1, 96);
    try {
      const response = await rconCommand(agentMapCommand({ x, y, radius }));
      return json(res, 200, {
        ok: true,
        data: parseRconJson(response, "RCON map returned invalid JSON"),
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
    const availableLimit = clampInt(limits.available, 50, 0, AGENT_MAX_RESEARCH);
    const lockedLimit = clampInt(limits.locked, 50, 0, AGENT_MAX_RESEARCH);
    const completedLimit = clampInt(limits.completed, 50, 0, AGENT_MAX_RESEARCH);
    try {
      const response = await rconCommand(
        agentResearchCommand({ availableLimit, lockedLimit, completedLimit }),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      data = normalizeResearchData(data);
      const counts = data?.counts || {};
      const truncated = {
        available: counts.available_included < counts.available_total,
        locked: counts.locked_included < counts.locked_total,
        completed: counts.completed_included < counts.completed_total,
      };
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
      .filter(
        (e) =>
          e?.name &&
          Number.isFinite(Number(e?.anchor?.x)) &&
          Number.isFinite(Number(e?.anchor?.y)),
      ) as BuildRequest[];
    try {
      const results: any[] = [];
      for (const entity of trimmed) {
        const destination = parseRconJson<any>(
          await rconCommand(agentBuildDestinationCommand(entity)),
          "RCON build destination returned invalid JSON",
        );
        if (!destination?.ok) {
          results.push({
            ok: false,
            name: entity.name,
            requested_anchor: entity.anchor,
            error: destination?.error || "no_reachable_staging_position",
          });
          continue;
        }
        const movement = await movePlayerTo(
          Number(destination.position.x),
          Number(destination.position.y),
        );
        if (!movement.ok) {
          results.push({
            ok: false,
            name: entity.name,
            requested_anchor: entity.anchor,
            error: movement.error || "movement_failed",
            movement: movement.movement,
          });
          continue;
        }
        const response = await rconCommand(agentNativeBuildCommand(entity));
        const result = parseRconJson<any>(response, "RCON build returned invalid JSON");
        results.push({ ...result, movement: movement.movement });
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
          agentMineProbeCommand({
            x: Number(target.x),
            y: Number(target.y),
            kind: target.kind,
            name: target.name,
          }),
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
        const movement = await moveNearEntity({
          x: Number(target.x),
          y: Number(target.y),
          kind: target.kind,
          name: target.name,
        });
        if (!movement?.ok) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: movement?.error || "movement_failed",
            movement: movement?.movement,
          });
          continue;
        }
        const response = await rconCommand(
          agentMineCommand([{
            x: Number(target.x),
            y: Number(target.y),
            kind: target.kind,
            name: target.name,
          }]),
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
          results.push({ ...entry, movement: movement.movement });
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
        const steps = Math.max(1, Math.ceil(distance / 0.75));
        const stepDelayMs = walkDelayMs(distance) / steps;
        let movedX = playerPos.x;
        let movedY = playerPos.y;
        let error: string | null = null;
        for (let step = 1; step <= steps; step++) {
          if (stepDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
          }
          const fraction = step / steps;
          const nextX = playerPos.x + (targetX - playerPos.x) * fraction;
          const nextY = playerPos.y + (targetY - playerPos.y) * fraction;
          const response = await rconCommand(
            agentMoveStepCommand({
              x: nextX,
              y: nextY,
              direction: directionForVector(nextX - movedX, nextY - movedY),
            }),
          );
          const data = parseRconJson<any>(response, "RCON move step returned invalid JSON");
          if (!data?.ok) {
            error = data?.error || "blocked";
            break;
          }
          movedX = data.x;
          movedY = data.y;
        }
        results.push({
          x: Number(target.x),
          y: Number(target.y),
          ok: !error,
          moved_x: movedX,
          moved_y: movedY,
          ...(error ? { error } : {}),
        });
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
        const movement = await moveNearEntity({
          x: Number(target.x),
          y: Number(target.y),
        });
        if (!movement?.ok) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: movement?.error || "movement_failed",
            movement: movement?.movement,
          });
          continue;
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
          results.push({ ...entry, movement: movement.movement });
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
        const movement = await moveNearEntity({
          x: Number(target.x),
          y: Number(target.y),
        });
        if (!movement?.ok) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: movement?.error || "movement_failed",
            movement: movement?.movement,
          });
          continue;
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
          results.push({ ...entry, movement: movement.movement });
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
      const movement = await moveNearEntity({ x: Number(to.x), y: Number(to.y) });
      if (!movement?.ok) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: movement?.error || "movement_failed", movement: movement?.movement },
        });
      }
      const response = await rconCommand(
        agentInsertCommand({ x: Number(to.x), y: Number(to.y), item, count }),
      );
      const data = parseRconJson<any>(
        response,
        "RCON insert returned invalid JSON",
      );
      return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
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
      const movement = await moveNearEntity({ x: Number(from.x), y: Number(from.y) });
      if (!movement?.ok) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: movement?.error || "movement_failed", movement: movement?.movement },
        });
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
      return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
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
      data = normalizeEntityData(data);
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
    url.pathname === "/api/agent/observe/placement"
  ) {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
    if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
    const placements = Array.isArray(body?.placements) ? body.placements : [];
    const valid = placements.slice(0, AGENT_MAX_ACTIONS).filter(
      (item: any) =>
        typeof item?.name === "string" &&
        Number.isFinite(Number(item?.anchor?.x)) &&
        Number.isFinite(Number(item?.anchor?.y)),
    ) as BuildRequest[];
    try {
      const results = [];
      for (const item of valid) {
        const result = parseRconJson<any>(
          await rconCommand(agentNativeBuildCommand(item, true)),
          "RCON placement analysis returned invalid JSON",
        );
        const diagnostics = result?.diagnostics;
        if (diagnostics) {
          diagnostics.nearest_valid_positions = arrayOrEmpty(diagnostics.nearest_valid_positions);
          if (diagnostics.terrain) diagnostics.terrain.tile_names = arrayOrEmpty(diagnostics.terrain.tile_names);
          if (diagnostics.collision) diagnostics.collision.possible_blockers = arrayOrEmpty(diagnostics.collision.possible_blockers);
        }
        results.push(result);
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: placements.length > valid.length,
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
        agentChartedResourcesCommand({ x, y, radius }),
        15_000,
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      if (data && typeof data === "object") {
        data.patches = arrayOrEmpty(data.patches);
        data.shoreline_candidates = arrayOrEmpty(data.shoreline_candidates);
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
      data = normalizePrototypeData(data);
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

  if (req.method === "POST" && url.pathname === "/api/server/save") {
    if (!getRunningPid()) {
      return json(res, 409, { error: "Server not running" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    try {
      const response = await rconCommand("/save", 30_000);
      return json(res, 200, { ok: true, save: state.save, response });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "Failed to save game" });
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
