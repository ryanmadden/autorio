#!/usr/bin/env node

const DEFAULT_BASE = process.env.FACTORIO_API_BASE || "http://localhost:3000";

type ResponseShape = {
  ok: boolean;
  cmd: string;
  data?: unknown;
  error?: string;
  truncated?: boolean | Record<string, boolean>;
  timing_ms: number;
};

type ParsedArgs = {
  base: string;
  command: string | null;
  flags: Map<string, string[]>;
  positionals: string[];
};

function writeResponse(resp: ResponseShape) {
  process.stdout.write(`${JSON.stringify(resp)}\n`);
}

function parseJsonIfString(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function usageGlobal() {
  return `factorio <command> [options]

Commands:
  server-status
  server-start --save <name>.zip
  server-stop
  server-saves
  observe-world --window-x <n> --window-y <n> --radius <n> --include tiles,entities
  observe-player --limit-inventory <n> --limit-equipment <n>
  observe-research --limit-available <n>
  observe-recipes --limit-recipes <n> [--unlocked-only]
  observe-entity --target x,y [--target ...] [--targets-json <json>]
  observe-resources --window-x <n> --window-y <n> --radius <n>
  observe-entity-prototype --name <entity-name>
  act-build --entity name,x,y,dir [--entity ...] [--entities-json <json>]
  act-mine --target x,y [--target ...] [--targets-json <json>]
  act-rotate --target x,y [--target ...] [--targets-json <json>]
  act-set-recipe --target x,y,recipe [--target ...] [--targets-json <json>]
  act-research --technology <name>
  act-craft --item <name> --count <n>
  act-insert --entity x,y --item <name> --count <n>
  act-extract --entity x,y --item <name> --count <n|all>
  wait --ms <n>

Global options:
  --base <url> (default: FACTORIO_API_BASE or http://localhost:3000)
  --help

More help:
  Run: factorio <command> --help
`;
}

function usageForCommand(command: string | null) {
  switch (command) {
    case "server-status":
      return (
        "server-status: Show whether the server is running and RCON is connected.\n" +
        "Usage: factorio server-status\n"
      );
    case "server-start":
      return (
        "server-start: Launch the headless server with the given save.\n" +
        "Usage: factorio server-start --save <name>.zip\n"
      );
    case "server-stop":
      return (
        "server-stop: Stop the running server (saves and exits).\n" +
        "Usage: factorio server-stop\n"
      );
    case "server-saves":
      return (
        "server-saves: List available save files on the server.\n" +
        "Usage: factorio server-saves\n"
      );
    case "observe-world":
      return (
        "observe-world: Fetch tiles/entities in a window around a target position.\n" +
        "Usage: factorio observe-world --window-x <n> --window-y <n> --radius <n> --include tiles,entities\n"
      );
    case "observe-player":
      return (
        "observe-player: Inspect player position, health, inventories, and equipment.\n" +
        "Usage: factorio observe-player --limit-inventory <n> --limit-equipment <n>\n"
      );
    case "observe-research":
      return (
        "observe-research: Get current research, queue, and available technologies.\n" +
        "Usage: factorio observe-research --limit-available <n>\n"
      );
    case "observe-recipes":
      return (
        "observe-recipes: List available recipes and their ingredients/products.\n" +
        "Usage: factorio observe-recipes --limit-recipes <n> [--unlocked-only]\n"
      );
    case "observe-entity":
      return (
        "observe-entity: Inspect entity status, fuel, fluids, recipe, inventory.\n" +
        "Usage: factorio observe-entity --target x,y [--target ...]\n" +
        "   or: factorio observe-entity --targets-json <json>\n"
      );
    case "observe-resources":
      return (
        "observe-resources: Scan for resource patches in a radius.\n" +
        "Usage: factorio observe-resources --window-x <n> --window-y <n> --radius <n>\n"
      );
    case "observe-entity-prototype":
      return (
        "observe-entity-prototype: Look up entity dimensions, fluid connections, energy info.\n" +
        "Usage: factorio observe-entity-prototype --name <entity-name>\n"
      );
    case "act-build":
      return (
        "act-build: Place entities at tile coordinates (direction optional).\n" +
        "Usage: factorio act-build --entity name,x,y,dir [--entity ...]\n" +
        "   or: factorio act-build --entities-json <json>\n" +
        "Direction: 0=north (up), 4=east (right), 8=south (down), 12=west (left).\n"
      );
    case "act-mine":
      return (
        "act-mine: Mine entities at target tile coordinates (first entity at each point).\n" +
        "Usage: factorio act-mine --target x,y [--target ...]\n" +
        "   or: factorio act-mine --targets-json <json>\n"
      );
    case "act-rotate":
      return (
        "act-rotate: Rotate entities at target tile coordinates (first entity at each point).\n" +
        "Usage: factorio act-rotate --target x,y [--target ...]\n" +
        "   or: factorio act-rotate --targets-json <json>\n" +
        "Direction (in results): 0=north (up), 4=east (right), 8=south (down), 12=west (left).\n"
      );
    case "act-set-recipe":
      return (
        "act-set-recipe: Set the recipe on assemblers at target tile coordinates.\n" +
        "Usage: factorio act-set-recipe --target x,y,recipe [--target ...]\n" +
        "   or: factorio act-set-recipe --targets-json <json>\n"
      );
    case "act-research":
      return (
        "act-research: Start researching a technology.\n" +
        "Usage: factorio act-research --technology <name>\n"
      );
    case "act-craft":
      return (
        "act-craft: Start crafting a recipe in the player's crafting queue.\n" +
        "Usage: factorio act-craft --item <name> --count <n>\n"
      );
    case "act-insert":
      return (
        "act-insert: Move items from player inventory into an entity at x,y.\n" +
        "Usage: factorio act-insert --entity x,y --item <name> --count <n>\n"
      );
    case "act-extract":
      return (
        "act-extract: Remove items from an entity at x,y into player inventory.\n" +
        "Usage: factorio act-extract --entity x,y --item <name> --count <n|all>\n"
      );
    case "wait":
      return (
        "wait: Sleep locally for N milliseconds between actions.\n" +
        "Usage: factorio wait --ms <n>\n"
      );
    default:
      return null;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let base = DEFAULT_BASE;
  let sawHelp = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      sawHelp = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      let key = "";
      let value: string | null = null;
      if (eqIdx >= 0) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        } else {
          value = "true";
        }
      }
      if (key === "base") {
        base = value ?? base;
        continue;
      }
      const existing = flags.get(key) ?? [];
      existing.push(value ?? "");
      flags.set(key, existing);
      continue;
    }
    positionals.push(arg);
  }
  const command = positionals.shift() ?? null;
  if (sawHelp) {
    const helpArgs = command ? [command, ...positionals] : positionals;
    return { base, command: "help", flags, positionals: helpArgs };
  }
  return { base, command, flags, positionals };
}

function getFlag(flags: Map<string, string[]>, name: string) {
  const values = flags.get(name);
  return values ? values[values.length - 1] : undefined;
}

function getFlagAll(flags: Map<string, string[]>, name: string) {
  return flags.get(name) ?? [];
}

function parseNumber(value: string | undefined, fallback?: number) {
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function parseCsv(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseEntities(values: string[]) {
  return values.map((entry) => {
    const parts = entry.split(",").map((p) => p.trim());
    const name = parts[0];
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const direction = parts[3] !== undefined ? Number(parts[3]) : undefined;
    if (!name || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid --entity '${entry}'`);
    }
    if (direction !== undefined && !Number.isFinite(direction)) {
      throw new Error(`Invalid --entity direction in '${entry}'`);
    }
    return { name, x, y, direction };
  });
}

function parseTargets(values: string[], requireRecipe: boolean) {
  return values.map((entry) => {
    const parts = entry.split(",").map((p) => p.trim());
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const recipe = parts[2];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid --target '${entry}'`);
    }
    if (requireRecipe && !recipe) {
      throw new Error(`Missing recipe in --target '${entry}'`);
    }
    return requireRecipe ? { x, y, recipe } : { x, y };
  });
}

async function httpRequest(
  base: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const url = `${base}${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const error = data?.error || `HTTP ${res.status}`;
    throw new Error(error);
  }
  return data;
}

async function main() {
  const started = Date.now();
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.command || parsed.command === "help") {
    const specific = parsed.command
      ? usageForCommand(parsed.positionals[0] ?? null)
      : null;
    process.stderr.write(specific ?? usageGlobal());
    process.exitCode = 1;
    return;
  }

  const cmd = parsed.command;
  try {
    switch (cmd) {
      case "server-status": {
        const data = await httpRequest(
          parsed.base,
          "GET",
          "/api/server/status",
        );
        writeResponse({ ok: true, cmd, data, timing_ms: Date.now() - started });
        return;
      }
      case "server-start": {
        const save = getFlag(parsed.flags, "save");
        if (!save) throw new Error("Missing --save");
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/server/start",
          {
            save,
          },
        );
        writeResponse({ ok: true, cmd, data, timing_ms: Date.now() - started });
        return;
      }
      case "server-stop": {
        const data = await httpRequest(parsed.base, "POST", "/api/server/stop");
        writeResponse({ ok: true, cmd, data, timing_ms: Date.now() - started });
        return;
      }
      case "server-saves": {
        const data = await httpRequest(parsed.base, "GET", "/api/saves");
        writeResponse({ ok: true, cmd, data, timing_ms: Date.now() - started });
        return;
      }
      case "observe-world": {
        const windowX = parseNumber(getFlag(parsed.flags, "window-x"), 0);
        const windowY = parseNumber(getFlag(parsed.flags, "window-y"), 0);
        const radius = parseNumber(getFlag(parsed.flags, "radius"), 12);
        const include = parseCsv(getFlag(parsed.flags, "include"));
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/observe/world",
          {
            window: { x: windowX, y: windowY, radius },
            include: include.length > 0 ? include : undefined,
          },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "observe-player": {
        const limitInventory = parseNumber(
          getFlag(parsed.flags, "limit-inventory"),
          undefined,
        );
        const limitEquipment = parseNumber(
          getFlag(parsed.flags, "limit-equipment"),
          undefined,
        );
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/observe/player",
          {
            limits: {
              inventory_slots: limitInventory,
              equipment_slots: limitEquipment,
            },
          },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "observe-research": {
        const limitAvailable = parseNumber(
          getFlag(parsed.flags, "limit-available"),
          undefined,
        );
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/observe/research",
          { limits: { available: limitAvailable } },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "observe-recipes": {
        const limitRecipes = parseNumber(
          getFlag(parsed.flags, "limit-recipes"),
          undefined,
        );
        const unlockedOnly = Boolean(getFlag(parsed.flags, "unlocked-only"));
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/observe/recipes",
          {
            limits: { recipes: limitRecipes },
            filters: unlockedOnly ? { unlocked: true } : undefined,
          },
        );
        const payload = parseJsonIfString(data?.data ?? data);
        writeResponse({
          ok: true,
          cmd,
          data: payload,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "observe-entity": {
        const targetsJson = getFlag(parsed.flags, "targets-json");
        const targets = targetsJson
          ? JSON.parse(targetsJson)
          : parseTargets(getFlagAll(parsed.flags, "target"), false);
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/observe/entity",
          { targets },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "observe-resources": {
        const windowX = parseNumber(getFlag(parsed.flags, "window-x"), 0);
        const windowY = parseNumber(getFlag(parsed.flags, "window-y"), 0);
        const radius = parseNumber(getFlag(parsed.flags, "radius"), 50);
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/observe/resources",
          { window: { x: windowX, y: windowY, radius } },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "observe-entity-prototype": {
        const name = getFlag(parsed.flags, "name");
        if (!name) throw new Error("Missing --name");
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/observe/entity-prototype",
          { name },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-build": {
        const entitiesJson = getFlag(parsed.flags, "entities-json");
        const entities = entitiesJson
          ? JSON.parse(entitiesJson)
          : parseEntities(getFlagAll(parsed.flags, "entity"));
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/build",
          { entities },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-mine": {
        const targetsJson = getFlag(parsed.flags, "targets-json");
        const targets = targetsJson
          ? JSON.parse(targetsJson)
          : parseTargets(getFlagAll(parsed.flags, "target"), false);
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/mine",
          { targets },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-rotate": {
        const targetsJson = getFlag(parsed.flags, "targets-json");
        const targets = targetsJson
          ? JSON.parse(targetsJson)
          : parseTargets(getFlagAll(parsed.flags, "target"), false);
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/rotate",
          { targets },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-set-recipe": {
        const targetsJson = getFlag(parsed.flags, "targets-json");
        const targets = targetsJson
          ? JSON.parse(targetsJson)
          : parseTargets(getFlagAll(parsed.flags, "target"), true);
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/set-recipe",
          { targets },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          truncated: data?.truncated,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-research": {
        const technology = getFlag(parsed.flags, "technology");
        if (!technology) throw new Error("Missing --technology");
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/research",
          { technology },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-craft": {
        const item = getFlag(parsed.flags, "item");
        const count = parseNumber(getFlag(parsed.flags, "count"), 1);
        if (!item) throw new Error("Missing --item");
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/craft",
          { item, count },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-insert": {
        const entityValue = getFlag(parsed.flags, "entity");
        const item = getFlag(parsed.flags, "item");
        const count = parseNumber(getFlag(parsed.flags, "count"), 1);
        if (!entityValue) throw new Error("Missing --entity");
        if (!item) throw new Error("Missing --item");
        const target = parseTargets([entityValue], false)[0];
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/insert",
          { entity: target, item, count },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "act-extract": {
        const entityValue = getFlag(parsed.flags, "entity");
        const item = getFlag(parsed.flags, "item");
        const rawCount = getFlag(parsed.flags, "count");
        const count: number | string =
          rawCount === "all" ? "all" : (parseNumber(rawCount, 1) ?? 1);
        if (!entityValue) throw new Error("Missing --entity");
        if (!item) throw new Error("Missing --item");
        const target = parseTargets([entityValue], false)[0];
        const data = await httpRequest(
          parsed.base,
          "POST",
          "/api/agent/act/extract",
          { entity: target, item, count },
        );
        writeResponse({
          ok: true,
          cmd,
          data: data?.data ?? data,
          timing_ms: Date.now() - started,
        });
        return;
      }
      case "wait": {
        const ms = parseNumber(getFlag(parsed.flags, "ms"), 0) ?? 0;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
        writeResponse({
          ok: true,
          cmd,
          data: { waited_ms: Math.max(0, ms) },
          timing_ms: Date.now() - started,
        });
        return;
      }
      default:
        throw new Error(`Unknown command '${cmd}'`);
    }
  } catch (err: any) {
    writeResponse({
      ok: false,
      cmd,
      error: err?.message || "Command failed",
      timing_ms: Date.now() - started,
    });
  }
}

main().catch((err) => {
  writeResponse({
    ok: false,
    cmd: "internal",
    error: err?.message || "Unhandled error",
    timing_ms: 0,
  });
});
