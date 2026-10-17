export const $ = id => document.getElementById(id);
export const activeStates = ["preparing", "launching", "running", "saving"];
export async function api(path, body) {
  const response = await fetch(path, {method:body === undefined ? "GET" : "POST", headers:{"Content-Type":"application/json"}, body:body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export function text(tag, value, className) {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className;
  return node;
}
export function duration(seconds) { const s = Math.floor(seconds || 0); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2,"0")}s`; }
export function detailsUrl(id) { return `/run.html?run=${encodeURIComponent(id)}`; }
export function recordingUrl(id) { return `/recording.html?run=${encodeURIComponent(id)}`; }
export function renderProgress(run) {
  $("runTitle").textContent = run.name || run.benchmark.title;
  $("state").textContent = run.state;
  $("elapsed").textContent = duration(run.elapsed_seconds);
  $("gameTime").textContent = run.latest ? duration((run.latest.tick-run.baseline_tick)/60) : "—";
  $("agent").textContent = run.model_label || run.model || run.agent;
  $("reason").textContent = [run.reason,...(run.warnings || [])].filter(Boolean).join(" · ");
  $("stop").disabled = !activeStates.includes(run.state) || run.state === "saving";
  $("milestones").replaceChildren(...run.benchmark.milestones.map(m => {
    const result = run.milestones[m.id];
    return text("span",`${result ? "✓" : "○"} ${m.label || m.id}${result ? ` · ${duration(result.wall_seconds)}` : ""}`,`milestone${result ? " done" : ""}`);
  }));
}
