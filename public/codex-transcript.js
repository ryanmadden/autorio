// Event state is independent of the DOM so updates replace rather than duplicate items.
export class CodexTranscript {
  pending = "";
  items = new Map();
  generation = 0;
  push(text) {
    this.pending += text;
    const changed = [];
    let newline;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if(event.type==="thread.started")this.generation++;
      if(event.item?.id && this.generation>1)event.item.id=`${this.generation}:${event.item.id}`;
      if (["item.started", "item.updated", "item.completed"].includes(event.type) && event.item?.id) {
        this.items.set(event.item.id, event.item); changed.push(event.item);
      } else if (event.type === "error" || event.type === "turn.failed") {
        const item = { id: `error-${this.items.size}`, type: "error", text: event.message || event.error?.message || "Codex failed" };
        this.items.set(item.id, item); changed.push(item);
      }
    }
    return changed;
  }
}
export function commandSummary(items) {
  const running = items.some(i => i.status === "in_progress");
  const failed = items.some(i => i.status === "failed" || (i.exit_code != null && i.exit_code !== 0));
  return `${running ? "Running" : "Ran"} ${items.length} command${items.length === 1 ? "" : "s"}${failed ? " · failed" : ""}`;
}
