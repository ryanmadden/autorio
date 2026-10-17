export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
export function pacificTimestamp(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",timeZoneName:"short"}).formatToParts(date);
  const value = (type: string) => parts.find(p => p.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")} ${value("timeZoneName")}`;
}
export function modelLabel(run: {agent:string; model?:string; reasoning_effort?:string}) {
  return run.agent === "manual" ? "Manual" : `${run.model || "Codex default"} (${run.reasoning_effort || "default"})`;
}
