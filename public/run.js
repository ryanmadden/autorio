import {ProductionChart} from "./production-chart.js";
import {$,api,text,renderProgress,recordingUrl} from "./run-view.js";
const id = new URLSearchParams(location.search).get("run"), chart = new ProductionChart();
let offset = 0, polling = false;
async function refresh() {
  if (polling || !id) return; polling = true;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    $("runContent").hidden=false; document.title = `${run.name || run.id} · Autorio`;
    renderProgress(run);
    $("resume").hidden=run.state!=="paused";
    $("resume").disabled=!run.resumable || run.video?.state==="rendering";
    $("resume").textContent=run.video?.state==="rendering"?"Finishing recording…":"Resume run";
    $("segmentsPanel").hidden=!run.segments?.length;
    $("checkpoint").textContent=run.checkpoint?`Saved game: ${run.checkpoint.file} · ${new Date(run.checkpoint.saved_at).toLocaleString("en-US",{timeZone:"America/Los_Angeles",timeZoneName:"short"})}`:"No checkpoint saved yet.";
    $("resumeNote").textContent=run.state==="paused"?"Waiting for you to resume after your Codex quota resets. Waiting and game loading are excluded from play time. The same game, agent session, and workspace will continue.":"Play time and measurements continue across segments; waiting time is excluded.";
    $("segments").replaceChildren(...(run.segments || []).map(segment=>{
      const row=text("p",`Segment ${segment.index} · ${segment.state} · ${(segment.start_seconds || 0).toFixed(1)}–${(segment.end_seconds ?? run.elapsed_seconds).toFixed(1)}s active play`);
      if(segment.video?.state==="ready") {const link=text("a","Download 6× video");link.href=`/api/runs/${encodeURIComponent(id)}/video?segment=${segment.index}`;link.download=`${id}-segment-${segment.index}-6x.mp4`;row.append(" · ",link);}
      else if(segment.video)row.append(` · video ${segment.video.state}`);
      return row;
    }));
    $("videoPanel").hidden=!run.video;
    if(run.video) {
      $("videoStatus").textContent=run.video.error || `${run.video.state} · 5 fps capture → 30 fps playback · silent 6× speed`;
      if(run.video.state==="ready") {
        const segment=run.segments?.at(-1)?.index;
        const url=`/api/runs/${encodeURIComponent(id)}/video${segment?`?segment=${segment}`:""}`;
        if($("runVideo").getAttribute("src")!==url)$("runVideo").src=url;
        $("runVideo").hidden=false;$("videoDownload").hidden=false;$("videoDownload").href=url;$("videoDownload").download=`${id}-6x.mp4`;
      }
    }
    if(run.video?.state!=="ready"){$("runVideo").hidden=true;$("videoDownload").hidden=true;}
    $("recordingLink").href = recordingUrl(id); $("recordingLink").hidden=false;
    const info = {Benchmark:run.benchmark.title, Seed:run.benchmark.map_gen.seed, Model:run.model_label || run.agent, "Time limit":`${run.max_seconds}s`, "Sampling interval":`${run.benchmark.sample_seconds}s`, "Created (Pacific)":new Date(run.created_at).toLocaleString("en-US",{timeZone:"America/Los_Angeles",timeZoneName:"short"}), "Run ID":run.id};
    $("runInfo").replaceChildren(...Object.entries(info).flatMap(([key,value])=>[text("dt",key),text("dd",String(value))]));
    $("task").textContent=run.benchmark.task;
    $("configuration").textContent=JSON.stringify({versions:run.versions,hashes:run.hashes,map_gen:run.benchmark.map_gen,always_day:run.benchmark.always_day},null,2);
    $("tokenUsage").textContent=run.usage ? `Tokens: ${run.usage.input_tokens.toLocaleString()} input (${(run.usage.cached_input_tokens || 0).toLocaleString()} cached) · ${run.usage.output_tokens.toLocaleString()} output · ${run.usage_status === "final" ? "final" : "last reported; interrupted requests may be missing"}` : "Token usage: not yet reported";
    const initial=run.baseline?.production || {};
    const items=Object.entries(run.latest?.production || {}).map(([name,count])=>[name,count-(initial[name] || 0)]).filter(([,count])=>count>0).sort((a,b)=>b[1]-a[1]);
    $("production").replaceChildren(...(items.length ? items.map(([name,count])=>text("p",`${name}: ${count}`)) : [text("p","No production recorded yet.","muted")]));
    await chart.update(run);
    const log=await api(`/api/runs/${encodeURIComponent(id)}/log?offset=${offset}`); offset=log.offset;
    if(log.text) {
      $("activity").textContent=($("activity").textContent+log.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"")).slice(-150000);
      if($("follow").checked) $("activity").scrollTop=$("activity").scrollHeight;
    }
    $("error").textContent="";
  } catch(error) { $("error").textContent=error.message; }
  finally { polling=false; }
}
$("activity").textContent="";
$("stop").onclick=async()=>{
  $("stop").disabled=true;
  try { await api(`/api/runs/${encodeURIComponent(id)}/stop`,{}); await refresh(); }
  catch(error) { $("error").textContent=error.message; }
};
$("resume").onclick=async()=>{
  $("resume").disabled=true;
  try{await api(`/api/runs/${encodeURIComponent(id)}/resume`,{});await refresh();}
  catch(error){$("error").textContent=error.message;$("resume").disabled=false;}
};
if(id) { await refresh(); setInterval(refresh,1000); } else $("error").textContent="Choose a run from the run history.";
