// Shared by entity observations and the launch action. Readiness describes the
// silo animation state; launch_rocket remains authoritative about launch rules.
export const ROCKET_STATE_LUA = [
  "local function rocket_state(e)",
  "if e.type~='rocket-silo' then return nil end",
  "local status=e.rocket_silo_status local name=tostring(status)",
  "for k,v in pairs(defines.rocket_silo_status) do if v==status then name=k break end end",
  "return {parts=e.rocket_parts,parts_required=e.prototype.rocket_parts_required,silo_status=name,ready=status==defines.rocket_silo_status.rocket_ready,rockets_launched=e.force.rockets_launched}",
  "end",
].join(" ");

type Target = { x: number; y: number };

export function launchRocketCommand(target: Target): string {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error("Invalid rocket target");
  return [
    "/sc", ROCKET_STATE_LUA,
    "local p=game.players[1]",
    `local x,y=${target.x},${target.y}`,
    "local function launch()",
    "if not p or not p.character then return {ok=false,error='no_character'} end",
    "local candidates=p.surface.find_entities_filtered{area={{x,y},{x+1,y+1}},type='rocket-silo'}",
    "table.sort(candidates,function(a,b) return a.unit_number<b.unit_number end)",
    "local e=candidates[1] if not e then return {ok=false,error='no_rocket_silo'} end",
    "if e.force~=p.force then return {ok=false,error='wrong_force'} end",
    "if not p.can_reach_entity(e) then return {ok=false,error='out_of_reach'} end",
    "local before=rocket_state(e)",
    "if not before.ready then return {ok=false,error='rocket_not_ready',rocket=before} end",
    "local launched=e.launch_rocket()",
    "return {ok=launched,launch_initiated=launched,error=not launched and 'rocket_not_ready' or nil,name=e.name,rocket=rocket_state(e)}",
    "end",
    "local result=launch() result.x=x result.y=y rcon.print(helpers.table_to_json(result))",
  ].join(" ");
}

export async function launchRocket(
  target: Target,
  approach: (target: Target) => Promise<any>,
  command: (lua: string) => Promise<string>,
  cancelled: () => boolean,
) {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return { ...target, ok: false, error: "invalid_target" };
  if (cancelled()) return { ...target, ok: false, error: "cancelled" };
  const movement = await approach(target);
  if (!movement?.ok) return { ...target, ok: false, error: movement?.error || "movement_failed", movement: movement?.movement };
  if (cancelled()) return { ...target, ok: false, error: "cancelled", movement: movement.movement };
  let result;
  try {
    result = JSON.parse(await command(launchRocketCommand(target)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("RCON launch-rocket returned invalid JSON");
    throw error;
  }
  if (!result || typeof result.ok !== "boolean") throw new Error("RCON launch-rocket returned invalid result");
  return { ...result, movement: movement.movement };
}
