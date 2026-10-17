import { CodexOutput } from "./codex-output.js";
import { CodexTranscript, commandSummary } from "./codex-transcript.js";
const output = document.getElementById("codexOutput");
const params = new URLSearchParams(location.search);
let id = params.get("run"), offset = 0, mode;
const decoder = new TextDecoder(), parser = new CodexOutput(), transcript = new CodexTranscript();
const entries = new Map();
let commandGroup;
document.title = "Agent transcript";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render(item) {
  let entry = entries.get(item.id);
  if (!entry) {
    if (item.type === "command_execution") {
      if (!commandGroup) {
        const details = element("details", "", "commands"), summary = element("summary");
        details.append(summary); output.append(details);
        commandGroup = { details, summary, items: new Map() };
      }
      const node = element("div", "", "command"); commandGroup.details.append(node);
      entry = { node, group: commandGroup };
    } else {
      commandGroup = null;
      const node = element("div", "", `message ${item.type === "reasoning" ? "reasoning" : ""}`);
      output.append(node); entry = { node };
    }
    entries.set(item.id, entry);
  }
  if (item.type === "command_execution") {
    entry.node.replaceChildren(element("pre", item.command || ""), element("pre", item.aggregated_output || "", "command-output"));
    entry.group.items.set(item.id, item);
    const items = [...entry.group.items.values()];
    entry.group.summary.textContent = commandSummary(items);
    entry.group.details.classList.toggle("failed", items.some(i => i.status === "failed" || (i.exit_code != null && i.exit_code !== 0)));
  } else if (item.type === "agent_message" || item.type === "reasoning" || item.type === "error") {
    entry.node.textContent = item.text || "";
    entry.node.classList.toggle("error", item.type === "error");
  } else {
    // Other tools remain inspectable without dumping JSON into the recording.
    const details = element("details"), summary = element("summary", item.type.replaceAll("_", " "));
    details.append(summary, element("pre", JSON.stringify(item, null, 2))); entry.node.replaceChildren(details);
  }
}
async function poll() {
  try {
    if (!id) {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error("Runs unavailable");
      id = (await response.json()).runs[0]?.id;
      if (id) { params.set("run", id); history.replaceState(null, "", `?${params}`); }
    }
    if (id) {
      if (!mode) {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error("Run unavailable");
        const run = await response.json();
        // Old runs and optional Terminal runs retain their original native display.
        mode = run.output_format === "events" ? "events" : "codex";
        const segment=run.segments?.find(s=>s.index===Number(params.get("segment")));
        if(segment)offset=mode==="events"?segment.event_offset:segment.native_offset;
      }
      const response = await fetch(`/api/runs/${encodeURIComponent(id)}/log?source=${mode}&offset=${offset}`);
      if (!response.ok) throw new Error("Output unavailable");
      const log = await response.json();
      const bytes = Uint8Array.from(atob(log.data || ""), c => c.charCodeAt(0));
      const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
      const text = decoder.decode(bytes, { stream: true });
      if (mode === "events") for (const item of transcript.push(text)) render(item);
      else for (const segment of parser.push(text)) {
        const span = element("span", segment.text); Object.assign(span.style, segment.style); output.append(span);
      }
      offset = log.offset;
      if (follow) output.scrollTop = output.scrollHeight;
    }
    document.title = "Agent transcript";
  } catch {
    document.title = "Agent transcript";
  } finally { setTimeout(poll, 250); }
}
void poll();
