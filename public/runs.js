import {$,api,text,duration,activeStates,renderProgress,detailsUrl} from "./run-view.js";
let runs = [], benchmarks = [], currentId, polling = false;
const checked = new Set();
function renderHistory() {
  $("runs").replaceChildren(...runs.map(run => {
    const row = document.createElement("tr"), box = document.createElement("input");
    box.type = "checkbox"; box.checked = checked.has(run.id); box.setAttribute("aria-label",`Compare ${run.name || run.id}`);
    box.onchange = () => { if(box.checked) checked.add(run.id); else checked.delete(run.id); $("compare").disabled = checked.size < 2; };
    const select = document.createElement("td"); select.append(box); row.append(select);
    const link = text("a",run.name || run.id); link.href = detailsUrl(run.id); link.title = run.id;
    const name = document.createElement("td"); name.append(link); row.append(name);
    for (const value of [run.benchmark.id,run.model_label || run.model || run.agent,run.state,duration(run.elapsed_seconds)]) row.append(text("td",value));
    return row;
  }));
  $("emptyHistory").hidden = runs.length > 0;
  $("launch").disabled = runs.some(r => activeStates.includes(r.state));
  $("compare").disabled = checked.size < 2;
}
async function refresh() {
  if (polling) return; polling = true;
  try {
    runs = (await api("/api/runs")).runs;
    for (const id of checked) if (!runs.some(r=>r.id===id)) checked.delete(id);
    renderHistory();
    const current = runs.find(r=>activeStates.includes(r.state)) || runs[0];
    currentId = current?.id;
    if (current) {
      renderProgress(current); $("detailsLink").href = detailsUrl(current.id); $("detailsLink").hidden = false;
    }
    $("error").textContent = "";
  } catch (error) { $("error").textContent = error.message; }
  finally { polling = false; }
}
$("benchmark").onchange = () => {
  const benchmark = benchmarks.find(b=>b.id === $("benchmark").value);
  $("task").textContent = benchmark.task; $("seconds").value = benchmark.max_seconds;
};
$("launchForm").onsubmit = async event => {
  event.preventDefault(); $("launch").disabled = true;
  try {
    const preset = $("model").selectedOptions[0];
    await api("/api/runs",{benchmark:$("benchmark").value, model:preset.dataset.model, reasoning_effort:preset.dataset.thinking, max_seconds:Number($("seconds").value), agent:"codex",terminal:false,capture_video:$("captureVideo").checked});
    await refresh();
  } catch (error) { $("error").textContent = error.message; $("launch").disabled = false; }
};
$("stop").onclick = async () => {
  if (!currentId) return;
  $("stop").disabled = true;
  try { await api(`/api/runs/${encodeURIComponent(currentId)}/stop`,{}); await refresh(); }
  catch (error) { $("error").textContent = error.message; }
};
$("compare").onclick = () => { if (checked.size >= 2) location.href = `/compare.html?runs=${[...checked].map(encodeURIComponent).join(",")}`; };
try {
  benchmarks = (await api("/api/benchmarks")).benchmarks;
  $("benchmark").replaceChildren(...benchmarks.map(b=>{ const option = text("option",b.title); option.value=b.id; return option; }));
  $("benchmark").value="smoke"; $("benchmark").onchange();
  await refresh(); setInterval(refresh,1000);
} catch (error) { $("error").textContent=error.message; }

void api("/api/obs/status").then(status=>{
  $("captureVideo").checked=status.enabled;
  $("obsStatus").textContent=status.connected ? "OBS connected · 5 fps capture → 30 fps playback · silent 6× timelapse" : "OBS is not connected. Enable its authenticated WebSocket server to record timelapses.";
}).catch(()=>{ $("obsStatus").textContent="OBS status unavailable."; });
