const saveSelect = document.getElementById("saveSelect");
const refreshBtn = document.getElementById("refreshBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const saveGameBtn = document.getElementById("saveGameBtn");
const newSaveName = document.getElementById("newSaveName");
const createSaveBtn = document.getElementById("createSaveBtn");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const logMetaEl = document.getElementById("logMeta");
const apiMsgEl = document.getElementById("apiMsg");
const rconInput = document.getElementById("rconInput");
const rconSendBtn = document.getElementById("rconSendBtn");
const rconOutput = document.getElementById("rconOutput");
const rconMeta = document.getElementById("rconMeta");

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
  startBtn.disabled = status.running;
  stopBtn.disabled = !status.running;
  saveGameBtn.disabled = !status.running;
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

saveGameBtn.addEventListener("click", async () => {
  saveGameBtn.disabled = true;
  try {
    const data = await api("/api/server/save", { method: "POST" });
    setApiMsg(`Saved: ${data.save || "active game"}`);
  } catch (err) {
    setApiMsg(err.message || String(err), true);
  } finally {
    await refreshStatus().catch(() => {});
  }
});

async function createNewSave() {
  const name = newSaveName.value.trim();
  if (!name) {
    setApiMsg("Enter a name for the new save", true);
    return;
  }
  createSaveBtn.disabled = true;
  setApiMsg(`Creating ${name}...`);
  try {
    const data = await api("/api/saves", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await refreshSaves();
    saveSelect.value = data.save;
    newSaveName.value = "";
    setApiMsg(`Created: ${data.save}`);
  } catch (err) {
    setApiMsg(err.message || String(err), true);
  } finally {
    createSaveBtn.disabled = false;
  }
}

createSaveBtn.addEventListener("click", createNewSave);
newSaveName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") createNewSave();
});

rconSendBtn.addEventListener("click", sendRconCommand);
rconInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendRconCommand();
});

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
