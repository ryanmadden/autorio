import {$,api,text,duration,detailsUrl} from "./run-view.js";
const ids = [...new Set((new URLSearchParams(location.search).get("runs") || "").split(",").filter(Boolean))];
try {
  if(ids.length<2) throw new Error("Select at least two runs from the history to compare.");
  const runs=await Promise.all(ids.map(id=>api(`/api/runs/${encodeURIComponent(id)}`)));
  const same=new Set(runs.map(r=>`${r.hashes?.benchmark}:${r.hashes?.baseline_save}:${r.hashes?.client}`)).size===1;
  $("matching").textContent=same ? "Matching benchmark, starting save, and Python client." : "Different benchmark, starting save, or Python client; comparison is approximate.";
  const header=document.createElement("tr"); header.append(text("th","Metric"));
  for(const run of runs) { const cell=document.createElement("th"), link=text("a",run.name || run.id); link.href=detailsUrl(run.id); cell.append(link); header.append(cell); }
  const rows=[['Agent',r=>r.model_label || r.model || r.agent],['Result',r=>r.state],['Active play time',r=>duration(r.elapsed_seconds)],['Input tokens',r=>r.usage?.input_tokens?.toLocaleString() ?? '—'],['Output tokens',r=>r.usage?.output_tokens?.toLocaleString() ?? '—']];
  for(const milestone of new Set(runs.flatMap(r=>Object.keys(r.milestones)))) rows.push([milestone,r=>r.milestones[milestone] ? `${r.milestones[milestone].wall_seconds.toFixed(1)}s` : '—']);
  $("comparison").replaceChildren(header,...rows.map(([label,value])=>{const row=document.createElement("tr");row.append(text("th",label),...runs.map(r=>text("td",value(r))));return row;}));
} catch(error) { $("error").textContent=error.message; }
