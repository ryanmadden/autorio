const $ = id => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attributes, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
export const ALL_ITEMS = "*", EACH_ITEM = "**";
const COLORS=["#d5ed9b","#88bbdf","#f2b880","#dca5dd","#7dd3bd","#f08e91","#c6b8ff","#e5d173","#85c5e6","#b7cc87"];
export function productionSeries(samples, baseline, selection, rate, game) {
  const names=[...new Set(samples.flatMap(sample=>Object.keys(sample.production || {})))].sort();
  const value=(sample,item)=>rate?(sample.production_per_game_minute?.[item] || 0):(sample.production?.[item] ?? baseline[item] ?? 0)-(baseline[item] || 0);
  const time=sample=>game?sample.game_ticks/60:sample.wall_seconds;
  const items=selection===EACH_ITEM?names:[selection];
  return items.map((item,index)=>({name:item===ALL_ITEMS?"All items combined":item,color:COLORS[index%COLORS.length],points:[{x:0,y:0},...samples.map(sample=>({x:time(sample),y:item===ALL_ITEMS?names.reduce((sum,name)=>sum+value(sample,name),0):value(sample,item)}))]}));
}
export class ProductionChart {
  constructor() {
    for (const id of ["chartItem", "chartMeasure", "chartTime"]) $(id).onchange = () => this.draw();
    this.reset(null);
  }
  reset(id) {
    if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
    this.id = id; this.offset = 0; this.pending = ""; this.decoder = new TextDecoder(); this.samples = []; this.run = null;
    if($("chartLegend"))$("chartLegend").replaceChildren();
    $("chartItem").replaceChildren(); $("productionChart").replaceChildren(); $("researchMarkers").replaceChildren();
    $("chartNote").textContent = "Waiting for telemetry."; $("telemetryDownload").removeAttribute("href");
  }
  async update(run) {
    if (this.id !== run.id) this.reset(run.id);
    const id = run.id;
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/log?source=telemetry&offset=${this.offset}`);
    if (!response.ok) return;
    const log = await response.json();
    if (id !== this.id) return;
    this.run = run;
    this.pending += this.decoder.decode(Uint8Array.from(atob(log.data || ""), c => c.charCodeAt(0)), { stream: true });
    let newline;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
      try { this.samples.push(JSON.parse(line)); } catch { /* Incomplete records retry on subsequent polls. */ }
    }
    this.offset = log.offset;
    const names = [...new Set(this.samples.flatMap(s => Object.keys(s.production || {})))].sort();
    const chosen = $("chartItem").value;
    $("chartItem").replaceChildren(...[[ALL_ITEMS,"All items combined"],[EACH_ITEM,"All items separately"],...names.map(name=>[name,name])].map(([name,label]) => { const option = document.createElement("option"); option.value = name; option.textContent = label; return option; }));
    if ([ALL_ITEMS,EACH_ITEM,...names].includes(chosen)) $("chartItem").value = chosen;
    this.draw();
    if (log.data) {
      if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = URL.createObjectURL(new Blob([JSON.stringify({ run: id, name: run.name, model: run.model, reasoning_effort: run.reasoning_effort, baseline: run.baseline, usage: run.usage, usage_status: run.usage_status, samples: this.samples, milestones: run.milestones, definitions: run.benchmark.milestones }, null, 2)], { type: "application/json" }));
      $("telemetryDownload").href = this.downloadUrl; $("telemetryDownload").download = `${id}-telemetry.json`;
    }
  }
  draw() {
    const chart = $("productionChart"); chart.replaceChildren();
    if (!this.run || !this.samples.length) return;
    const item = $("chartItem").value, rate = $("chartMeasure").value === "rate", game = $("chartTime").value === "game";
    const series=productionSeries(this.samples,this.run.baseline?.production || {},item,rate,game);
    const time = s => game ? s.game_ticks / 60 : s.wall_seconds;
    let maxX=this.samples.reduce((max,sample)=>Math.max(max,time(sample)),1),maxY=1;
    for(const line of series)for(const point of line.points){maxX=Math.max(maxX,point.x);maxY=Math.max(maxY,point.y);}
    const x = v => 60 + v / maxX * 810, y = v => 250 - v / maxY * 220;
    for (let i = 0; i <= 4; i++) {
      const a = i / 4;
      chart.append(svg("line", { x1: 60, x2: 870, y1: y(maxY*a), y2: y(maxY*a), stroke: "#303a40" }));
      chart.append(svg("text", { x: 50, y: y(maxY*a)+4, "text-anchor": "end" }, (maxY*a).toFixed(maxY < 10 ? 1 : 0)));
      chart.append(svg("text", { x: x(maxX*a), y: 275, "text-anchor": "middle" }, maxX < 120 ? `${(maxX*a).toFixed(1)}s` : `${(maxX*a/60).toFixed(1)}m`));
    }
    for(const line of series) {
      const polyline=svg("polyline",{points:line.points.map(p=>`${x(p.x)},${y(p.y)}`).join(" "),fill:"none",stroke:line.color,"stroke-width":2});
      polyline.append(svg("title",{},line.name));chart.append(polyline);
    }
    const legend=$("chartLegend");
    if(legend)legend.replaceChildren(...series.map(line=>{const span=document.createElement("span");span.textContent=line.name;span.style.color=line.color;return span;}));
    const markers = this.run.benchmark.milestones.filter(m => m.kind === "research" && m.name?.endsWith("-science-pack") && this.run.milestones[m.id]);
    $("researchMarkers").replaceChildren(...markers.map((m, index) => {
      const result = this.run.milestones[m.id], label = `${index+1}. ${m.label || m.name}: ${(time(result)/60).toFixed(2)}m${result.initial ? " (already unlocked at start)" : ""}`;
      const line = svg("line", { x1:x(time(result)), x2:x(time(result)), y1:30, y2:250, stroke:"#88bbdf", "stroke-dasharray":"4 4" });
      line.append(svg("title", {}, label)); chart.append(line, svg("text", { x:x(time(result))+4, y:20+(index%2)*15 }, String(index+1)));
      const span = document.createElement("span"); span.className = "milestone done"; span.textContent = label; return span;
    }));
    $("chartNote").textContent = `${item===ALL_ITEMS?"All items combined":item===EACH_ITEM?"All items separately":item || "No items produced yet"} · ${rate ? "items / game minute" : "total items produced since start"} · ${game ? "game time" : "active play time"}. Research markers use first observation (up to ${this.run.benchmark.sample_seconds}s sampling delay).${item===ALL_ITEMS?" Counts all item outputs, including intermediate products; this is an unweighted total, not inventory or net production.":""}`;
  }
}
