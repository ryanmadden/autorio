const saveSelect = document.getElementById("saveSelect");
const refreshBtn = document.getElementById("refreshBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const logMetaEl = document.getElementById("logMeta");
const apiMsgEl = document.getElementById("apiMsg");
const rconInput = document.getElementById("rconInput");
const rconSendBtn = document.getElementById("rconSendBtn");
const rconOutput = document.getElementById("rconOutput");
const rconMeta = document.getElementById("rconMeta");
const worldFetchBtn = document.getElementById("worldFetchBtn");
const worldOutput = document.getElementById("worldOutput");
const worldMeta = document.getElementById("worldMeta");
const placeItemsBtn = document.getElementById("placeItemsBtn");
const worldCanvas = document.getElementById("worldCanvas");
const worldLegend = document.getElementById("worldLegend");
const worldTooltip = document.getElementById("worldTooltip");

let lastWorld = null;
let lastRender = { gridSize: 25, offset: 12, tileSize: 10 };
let tileMap = new Map();
let entityMap = new Map();

function setApiMsg(msg, isError = false) {
  apiMsgEl.textContent = msg || "";
  apiMsgEl.style.color = isError ? "#f87171" : "";
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

function formatBytes(bytes) {
  if (bytes == null) return "-";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatCpu(pct) {
  if (pct == null) return "-";
  return `${pct.toFixed(1)}%`;
}

function renderStatus(status) {
  const rcon = status.rcon || {};
  let rconText = "not configured";
  if (rcon.configured) {
    rconText = rcon.connected
      ? `connected (${rcon.host}:${rcon.port})`
      : `disconnected (${rcon.host}:${rcon.port})`;
  }
  if (rcon.note) {
    rconText = `${rconText} - ${rcon.note}`;
  }
  if (rcon.lastError) {
    rconText = `${rconText} (last error: ${rcon.lastError})`;
  }

  const rows = [
    ["State", status.running ? "running" : "stopped"],
    ["PID", status.pid ?? "-"],
    ["Save", status.save ?? "-"],
    ["Started", status.startedAt ?? "-"],
    ["Uptime", status.running ? `${status.uptimeSec}s` : "-"],
    ["CPU", formatCpu(status.usage?.cpuPercent)],
    ["Memory", formatBytes(status.usage?.rssBytes)],
    ["RCON", rconText],
    ["Last Exit", status.lastExit ? JSON.stringify(status.lastExit) : "-"],
  ];

  statusEl.innerHTML = rows
    .map(([k, v]) => {
      if (k === "State") {
        const badge = status.running
          ? '<span class="badge ok">running</span>'
          : '<span class="badge bad">stopped</span>';
        return `<div class="muted">${k}</div><div>${badge}</div>`;
      }
      return `<div class="muted">${k}</div><div>${v}</div>`;
    })
    .join("");
}

async function refreshSaves() {
  const data = await api("/api/saves");
  saveSelect.innerHTML = "";
  for (const s of data.saves) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    saveSelect.appendChild(opt);
  }
  if (data.saves.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no saves found)";
    saveSelect.appendChild(opt);
  }
  return data;
}

async function refreshStatus() {
  const status = await api("/api/server/status");
  renderStatus(status);
  return status;
}

function renderLogs(lines) {
  if (!Array.isArray(lines)) {
    logEl.textContent = "";
    return;
  }
  const nearBottom =
    logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= 8;
  const text = lines
    .map((l) => `[${l.ts}] [${l.stream}] ${l.line}`)
    .join("\n");
  logEl.textContent = text || "(no logs yet)";
  logMetaEl.textContent = lines.length ? `${lines.length} lines` : "";
  if (nearBottom) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function tileColor(name) {
  if (!name) return "#1f2937";
  const n = name.toLowerCase();
  if (n.includes("deepwater") || n.includes("water")) return "#1d4ed8";
  if (n.includes("sand")) return "#d6b46a";
  if (n.includes("dirt")) return "#6b4f3a";
  if (n.includes("grass")) return "#2f9e44";
  if (n.includes("stone") || n.includes("concrete")) return "#6b7280";
  return "#334155";
}

function entityColor(entity) {
  const name = (entity?.name || "").toLowerCase();
  const type = (entity?.type || "").toLowerCase();
  if (name === "burner-mining-drill") return "#f59e0b";
  if (name === "transport-belt") return "#f97316";
  if (name === "burner-inserter") return "#f43f5e";
  if (name === "assembling-machine-1") return "#22c55e";
  if (name === "iron-chest") return "#94a3b8";
  if (type.includes("mining-drill")) return "#eab308";
  if (type.includes("transport-belt")) return "#fb923c";
  if (type.includes("inserter")) return "#fb7185";
  if (type.includes("assembling-machine")) return "#4ade80";
  if (type.includes("container")) return "#94a3b8";
  return "#38bdf8";
}

function buildLegend() {
  const items = [
    ["Burner drill", "#f59e0b"],
    ["Transport belt", "#f97316"],
    ["Burner inserter", "#f43f5e"],
    ["Assembler", "#22c55e"],
    ["Iron chest", "#94a3b8"],
    ["Other entities", "#38bdf8"],
  ];
  worldLegend.innerHTML = items
    .map(
      ([label, color]) =>
        `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${label}</div>`,
    )
    .join("");
}

function renderWorld(world) {
  if (!worldCanvas) return;
  lastWorld = world || null;
  const tiles = Array.isArray(world?.tiles) ? world.tiles : [];
  const entities = Array.isArray(world?.entities) ? world.entities : [];
  const panelWidth = worldCanvas.parentElement?.clientWidth || 500;
  const gridSize = 25;
  const offset = 12;
  const tileSize = Math.max(6, Math.floor(panelWidth / gridSize));
  lastRender = { gridSize, offset, tileSize };
  worldCanvas.width = tileSize * gridSize;
  worldCanvas.height = tileSize * gridSize;
  const ctx = worldCanvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, worldCanvas.width, worldCanvas.height);

  tileMap = new Map();
  for (const tile of tiles) {
    const x = Number(tile?.x);
    const y = Number(tile?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    tileMap.set(`${x},${y}`, tile);
    const gx = x + offset;
    const gy = y + offset;
    if (gx < 0 || gy < 0 || gx >= gridSize || gy >= gridSize) continue;
    ctx.fillStyle = tileColor(tile?.name);
    ctx.fillRect(gx * tileSize, gy * tileSize, tileSize, tileSize);
  }

  ctx.strokeStyle = "rgba(15, 23, 42, 0.35)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridSize; i += 1) {
    const p = i * tileSize + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, worldCanvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(worldCanvas.width, p);
    ctx.stroke();
  }

  const inset = Math.max(1, Math.floor(tileSize * 0.15));
  const size = Math.max(2, tileSize - inset * 2);
  entityMap = new Map();
  for (const entity of entities) {
    const txRaw =
      entity?.tile_x != null ? Number(entity.tile_x) : Number(entity?.x);
    const tyRaw =
      entity?.tile_y != null ? Number(entity.tile_y) : Number(entity?.y);
    if (!Number.isFinite(txRaw) || !Number.isFinite(tyRaw)) continue;
    const tx = Math.floor(txRaw);
    const ty = Math.floor(tyRaw);
    const hasBox =
      Number.isFinite(entity?.box_left) &&
      Number.isFinite(entity?.box_top) &&
      Number.isFinite(entity?.box_right) &&
      Number.isFinite(entity?.box_bottom);
    const tiles = [];
    if (hasBox) {
      const left = Number(entity.box_left);
      const top = Number(entity.box_top);
      const right = Number(entity.box_right);
      const bottom = Number(entity.box_bottom);
      const minX = Math.floor(left);
      const minY = Math.floor(top);
      const maxX = Math.ceil(right) - 1;
      const maxY = Math.ceil(bottom) - 1;
      for (let iy = minY; iy <= maxY; iy += 1) {
        for (let ix = minX; ix <= maxX; ix += 1) {
          tiles.push([ix, iy]);
        }
      }
    } else {
      tiles.push([tx, ty]);
    }
    const seenTiles = new Set();
    for (const [ix, iy] of tiles) {
      const tileKey = `${ix},${iy}`;
      if (seenTiles.has(tileKey)) continue;
      seenTiles.add(tileKey);
      const key = `${ix},${iy}`;
      const list = entityMap.get(key) || [];
      if (!list.includes(entity)) {
        list.push(entity);
      }
      entityMap.set(key, list);
    }
    const gx = tx + offset;
    const gy = ty + offset;
    if (gx < 0 || gy < 0 || gx >= gridSize || gy >= gridSize) continue;
    ctx.fillStyle = entityColor(entity);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = Math.max(1, Math.floor(tileSize / 6));
    if (hasBox) {
      const left = Number(entity.box_left);
      const top = Number(entity.box_top);
      const right = Number(entity.box_right);
      const bottom = Number(entity.box_bottom);
      const minX = Math.floor(left);
      const minY = Math.floor(top);
      const maxX = Math.ceil(right) - 1;
      const maxY = Math.ceil(bottom) - 1;
      const gx0 = minX + offset;
      const gy0 = minY + offset;
      const gx1 = maxX + offset;
      const gy1 = maxY + offset;
      if (
        gx1 >= 0 &&
        gy1 >= 0 &&
        gx0 < gridSize &&
        gy0 < gridSize
      ) {
        const clampedX0 = Math.max(0, gx0);
        const clampedY0 = Math.max(0, gy0);
        const clampedX1 = Math.min(gridSize - 1, gx1);
        const clampedY1 = Math.min(gridSize - 1, gy1);
        const px = clampedX0 * tileSize + inset;
        const py = clampedY0 * tileSize + inset;
        const w = (clampedX1 - clampedX0 + 1) * tileSize - inset * 2;
        const h = (clampedY1 - clampedY0 + 1) * tileSize - inset * 2;
        ctx.fillRect(px, py, w, h);
        ctx.strokeRect(px, py, w, h);
      }
    } else {
      const px = gx * tileSize + inset;
      const py = gy * tileSize + inset;
      ctx.fillRect(px, py, size, size);
      ctx.strokeRect(px, py, size, size);
    }
  }

  buildLegend();
}

function updateTooltip(e) {
  if (!worldCanvas || !worldTooltip || !lastWorld) return;
  const rect = worldCanvas.getBoundingClientRect();
  const { gridSize, offset, tileSize } = lastRender;
  const x = Math.floor((e.clientX - rect.left) / tileSize);
  const y = Math.floor((e.clientY - rect.top) / tileSize);
  if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) {
    worldTooltip.style.display = "none";
    return;
  }
  const wx = x - offset;
  const wy = y - offset;
  const tile = tileMap.get(`${wx},${wy}`);
  const entities = entityMap.get(`${wx},${wy}`) || [];
  const lines = [`Tile: (${wx}, ${wy})`];
  if (tile?.name) lines.push(`Terrain: ${tile.name}`);
  if (entities.length) {
    lines.push(`Entities: ${entities.length}`);
    for (const ent of entities) {
      const label = ent?.name || ent?.type || "entity";
      const health =
        typeof ent?.health === "number" ? ` (health ${ent.health})` : "";
      lines.push(`- ${label}${health}`);
    }
  } else {
    lines.push("Entities: 0");
  }
  worldTooltip.textContent = lines.join("\n");
  worldTooltip.style.display = "block";
  const left = Math.min(
    rect.width - 10,
    Math.max(0, e.clientX - rect.left),
  );
  const top = Math.min(
    rect.height - 10,
    Math.max(0, e.clientY - rect.top),
  );
  worldTooltip.style.left = `${left}px`;
  worldTooltip.style.top = `${top}px`;
}

if (worldCanvas) {
  worldCanvas.addEventListener("mousemove", updateTooltip);
  worldCanvas.addEventListener("mouseleave", () => {
    if (worldTooltip) worldTooltip.style.display = "none";
  });
}

async function refreshLogs() {
  const data = await api("/api/server/logs?limit=200");
  renderLogs(data.lines || []);
  return data;
}

async function sendRconCommand() {
  const command = rconInput.value.trim();
  if (!command) return;
  rconMeta.textContent = "sending...";
  try {
    const data = await api("/api/rcon/command", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
    rconOutput.textContent = data.response || "(empty response)";
    rconMeta.textContent = "ok";
  } catch (err) {
    rconOutput.textContent = err.message || String(err);
    rconMeta.textContent = "error";
  }
}

async function fetchWorldInfo() {
  worldMeta.textContent = "fetching...";
  try {
    const data = await api("/api/rcon/world");
    if (data.data && typeof data.data === "object") {
      renderWorld(data.data);
      worldOutput.textContent = JSON.stringify(data.data, null, 2);
    } else {
      worldOutput.textContent = data.response || "(empty response)";
    }
    worldMeta.textContent = "ok";
  } catch (err) {
    worldOutput.textContent = err.message || String(err);
    worldMeta.textContent = "error";
  }
}

async function placeTestItems() {
  worldMeta.textContent = "placing...";
  try {
    const data = await api("/api/rcon/test-items", { method: "POST" });
    if (data.data && typeof data.data === "object") {
      worldOutput.textContent = JSON.stringify(data.data, null, 2);
    } else {
      worldOutput.textContent = data.response || "(empty response)";
    }
    worldMeta.textContent = "ok";
  } catch (err) {
    worldOutput.textContent = err.message || String(err);
    worldMeta.textContent = "error";
  }
}

refreshBtn.addEventListener("click", async () => {
  try {
    const data = await refreshSaves();
    setApiMsg(`Loaded ${data.saves.length} saves`);
  } catch (err) {
    setApiMsg(err.message || String(err), true);
  }
});

startBtn.addEventListener("click", async () => {
  try {
    const save = saveSelect.value;
    const data = await api("/api/server/start", {
      method: "POST",
      body: JSON.stringify({ save }),
    });
    setApiMsg(`Started: ${data.save}`);
    await refreshStatus();
    await refreshLogs();
  } catch (err) {
    setApiMsg(err.message || String(err), true);
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await api("/api/server/stop", { method: "POST" });
    setApiMsg("Stop signal sent");
    await refreshStatus();
  } catch (err) {
    setApiMsg(err.message || String(err), true);
  }
});

rconSendBtn.addEventListener("click", sendRconCommand);
rconInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendRconCommand();
});
worldFetchBtn.addEventListener("click", fetchWorldInfo);
placeItemsBtn.addEventListener("click", placeTestItems);

(async () => {
  try {
    await refreshSaves();
    await refreshStatus();
    await refreshLogs();
  } catch (err) {
    setApiMsg(err.message || String(err), true);
  }

  setInterval(() => {
    refreshStatus().catch(() => {});
    refreshLogs().catch(() => {});
  }, 2500);
})();
