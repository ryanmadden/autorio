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

const AGENT_DEFAULT_RADIUS = 12;
const AGENT_MAX_TILES = 625;
const AGENT_MAX_ENTITIES = 200;
const AGENT_MAX_INVENTORY_SLOTS = 200;
const AGENT_MAX_EQUIPMENT_SLOTS = 50;
const AGENT_MAX_RECIPES = 300;
const AGENT_MAX_RESEARCH = 200;
const AGENT_MAX_ACTIONS = 50;

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

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function luaString(value: string) {
  return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/\"/g, "\\\\\"")}"`;
}

function agentWorldCommand(params: {
  x: number;
  y: number;
  radius: number;
  includeTiles: boolean;
  includeEntities: boolean;
  tileLimit: number;
  entityLimit: number;
}): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  const parts = [
    "/c",
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
    `local tile_limit=${params.tileLimit}`,
    `local entity_limit=${params.entityLimit}`,
    "local tiles_out={}",
    "local tiles_total=0",
    "local tiles_included=0",
    "if true then",
    `local include_tiles=${params.includeTiles ? "true" : "false"}`,
    "if include_tiles then",
    "for y=min_y,max_y do",
    "for x=min_x,max_x do",
    "tiles_total=tiles_total+1",
    "if tiles_included < tile_limit then",
    "local t=s.get_tile(x,y)",
    "table.insert(tiles_out,'{\"x\":'..x..',\"y\":'..y..',\"name\":'..esc(t.name)..'}')",
    "tiles_included=tiles_included+1",
    "end",
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
    "if entities_included >= entity_limit then break end",
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
    "local entry='{\"name\":'..esc(e.name)..',\"type\":'..esc(e.type)..',\"x\":'..esc(e.position.x)",
    "entry=entry..',\"y\":'..esc(e.position.y)..',\"tile_x\":'..esc(tile_x)..',\"tile_y\":'..esc(tile_y)",
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
    "/c",
    "local player=game.players[1]",
    "if not player then rcon.print('{\"error\":\"No player\"}') return end",
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
    "local entry='{\"slot\":'..i..',\"name\":'..esc(stack.name)..',\"count\":'..stack.count",
    "entry=entry..',\"durability\":'..esc(stack.durability)",
    "entry=entry..',\"ammo\":'..esc(stack.ammo)..'}'",
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
    "local out={}",
    "table.insert(out,'\"player\":{')",
    "table.insert(out,'\"name\":'..esc(player.name))",
    "table.insert(out,',\"x\":'..esc(player.position.x))",
    "table.insert(out,',\"y\":'..esc(player.position.y))",
    "table.insert(out,',\"direction\":'..esc(player.direction))",
    "table.insert(out,',\"health\":'..esc(player.character and player.character.health))",
    "table.insert(out,',\"energy\":'..esc(player.character and player.character.energy))",
    "table.insert(out,',\"inventories\":['..table.concat(inventories,',')..']')",
    "table.insert(out,',\"equipment\":['..table.concat(equipment_out,',')..']')",
    "table.insert(out,'}')",
    "table.insert(out,',\"counts\":{\"inventory_total\":'..inv_total..',\"inventory_included\":'..inv_included..',\"equipment_total\":'..equip_total..',\"equipment_included\":'..equip_included..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentResearchCommand(params: { limit: number }): string {
  const parts = [
    "/c",
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
    "if tech.enabled and not tech.researched then",
    "available_total=available_total+1",
    "if available_included < limit then",
    "table.insert(available_out,'{\"name\":'..esc(name)..',\"level\":'..esc(tech.level)..'}')",
    "available_included=available_included+1",
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
    "table.insert(out,',\"queue\":['..table.concat(queue_out,',')..']')",
    "table.insert(out,',\"available\":['..table.concat(available_out,',')..']')",
    "table.insert(out,',\"counts\":{\"available_total\":'..available_total..',\"available_included\":'..available_included..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentRecipesCommand(params: { limit: number; unlockedOnly: boolean }): string {
  const parts = [
    "/c",
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
    "table.insert(res,',\"counts\":{\"total\":'..total..',\"included\":'..included..'}')",
    "rcon.print('{'..table.concat(res,',')..'}')",
  ];
  return parts.join(" ");
}

function agentBuildCommand(items: Array<{ name: string; x: number; y: number; direction?: number }>): string {
  const parts = [
    "/c",
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
    "local function place(name,x,y,dir)",
    "local ok,err=pcall(function()",
    "s.create_entity{ name=name, position={x=x,y=y}, direction=dir, force=force }",
    "end)",
    "if ok then return {name=name,x=x,y=y,ok=true} end",
    "return {name=name,x=x,y=y,ok=false,error=tostring(err)}",
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
    "/c",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "if not player then rcon.print('{\"error\":\"No player\"}') return end",
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
    "local function mine(x,y)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
    "local ok,err=pcall(function() player.mine_entity(e) end)",
    "if ok then return {x=x,y=y,name=e.name,ok=true} end",
    "return {x=x,y=y,name=e.name,ok=false,error=tostring(err)}",
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

function agentRotateCommand(targets: Array<{ x: number; y: number }>): string {
  const parts = [
    "/c",
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
    "local function rotate(x,y)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
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

function agentSetRecipeCommand(targets: Array<{ x: number; y: number; recipe: string }>): string {
  const parts = [
    "/c",
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
    "local function set_recipe(x,y,recipe)",
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
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

function agentCraftCommand(recipe: string, count: number): string {
  const parts = [
    "/c",
    "local player=game.players[1]",
    "if not player then rcon.print('{\"error\":\"No player\"}') return end",
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
    "local ok,err=pcall(function() player.begin_crafting{recipe=recipe,count=count} end)",
    "local out={}",
    "table.insert(out,'\"recipe\":'..esc(recipe))",
    "table.insert(out,',\"count\":'..esc(count))",
    "table.insert(out,',\"ok\":'..tostring(ok))",
    "if err then table.insert(out,',\"error\":'..esc(tostring(err))) end",
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
    "/c",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "if not player then rcon.print('{\"ok\":false,\"error\":\"No player\"}') return end",
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
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    "if not e then rcon.print('{\"ok\":false,\"error\":\"no_entity\"}') return end",
    "local removed=player.remove_item{name=item,count=count}",
    "local inserted=e.insert{name=item,count=removed}",
    "if inserted < removed then player.insert{name=item,count=removed-inserted} end",
    "local out={}",
    "table.insert(out,'\"ok\":true')",
    "table.insert(out,',\"removed\":'..esc(removed))",
    "table.insert(out,',\"inserted\":'..esc(inserted))",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

function agentExtractCommand(params: {
  x: number;
  y: number;
  item: string;
  count: number;
}): string {
  const parts = [
    "/c",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "if not player then rcon.print('{\"ok\":false,\"error\":\"No player\"}') return end",
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
    "local ents=s.find_entities_filtered{position={x,y}} or {}",
    "local e=ents[1]",
    "if not e then rcon.print('{\"ok\":false,\"error\":\"no_entity\"}') return end",
    "local removed=e.remove_item{name=item,count=count}",
    "local inserted=player.insert{name=item,count=removed}",
    "local out={}",
    "table.insert(out,'\"ok\":true')",
    "table.insert(out,',\"removed\":'..esc(removed))",
    "table.insert(out,',\"inserted\":'..esc(inserted))",
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
    const limits = body?.limits || {};
    const tileLimit = clampInt(limits.tiles, AGENT_MAX_TILES, 1, AGENT_MAX_TILES);
    const entityLimit = clampInt(
      limits.entities,
      AGENT_MAX_ENTITIES,
      1,
      AGENT_MAX_ENTITIES,
    );
    try {
      const response = await rconCommand(
        agentWorldCommand({
          x,
          y,
          radius,
          includeTiles,
          includeEntities,
          tileLimit,
          entityLimit,
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
    const limit = clampInt(limits.available, AGENT_MAX_RESEARCH, 1, AGENT_MAX_RESEARCH);
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
    const limit = clampInt(limits.recipes, AGENT_MAX_RECIPES, 1, AGENT_MAX_RECIPES);
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
    const trimmed = entities.slice(0, max).filter((e) => e?.name && e?.x !== undefined && e?.y !== undefined);
    try {
      const response = await rconCommand(agentBuildCommand(trimmed));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      return json(res, 200, {
        ok: true,
        data,
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
    const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const response = await rconCommand(agentMineCommand(trimmed));
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
    const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const response = await rconCommand(agentRotateCommand(trimmed));
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
      const response = await rconCommand(agentSetRecipeCommand(trimmed));
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
      const response = await rconCommand(
        agentInsertCommand({ x: Number(to.x), y: Number(to.y), item, count }),
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
    const count = clampInt(body?.count, 1, 1, 100000);
    if (!item || typeof item !== "string") {
      return json(res, 400, { error: "Missing item" });
    }
    if (from?.x === undefined || from?.y === undefined) {
      return json(res, 400, { error: "Missing target" });
    }
    try {
      const response = await rconCommand(
        agentExtractCommand({
          x: Number(from.x),
          y: Number(from.y),
          item,
          count,
        }),
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
