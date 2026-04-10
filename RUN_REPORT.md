# Factorio CLI Run Report

An AI agent attempted to beat Factorio (launch a rocket) using the CLI. This document captures the problems encountered and proposed solutions, ordered by impact on playability.

---

## Problem 1: Crafting Appears Instant But Is Async

### What happened
`act-craft` returns `{"ok": true}` immediately, but items take real game-time to appear in inventory. The agent crafted 200 automation science packs (5 seconds each = 1000 seconds total), got a success response, then spent ~20 minutes debugging why zero science packs were in inventory. The agent had no way to know crafting was queued, how long it would take, or how to observe the queue.

### Current response
```json
{"recipe": "automation-science-pack", "count": 200, "ok": true}
```

### Proposed fix
**Always include the crafting queue in `observe-player`** output:
```json
{"crafting_queue": [
  {"recipe": "iron-gear-wheel", "count": 45, "remaining_time": 2.3},
  {"recipe": "automation-science-pack", "count": 187, "remaining_time": 935.0}
]}
```

---

## Problem 2: No Entity Inspection

### What happened
After placing an offshore pump, boiler, and steam engine, the power system didn't work. The agent had no way to determine why — it couldn't check entity status (no fuel? no fluid? no power?), couldn't see fluid connections, and couldn't check entity contents. The agent had to reverse-engineer the RCON API and write raw Lua commands (`entity.status`, `entity.fluidbox.get_connections()`) to debug.

### Proposed fix
Add `observe-entity --target x,y` that returns:
```json
{
  "name": "boiler",
  "position": {"x": -13.5, "y": -48},
  "direction": 0,
  "status": "no_fluid",
  "health": 200,
  "max_health": 200,
  "energy": 0,
  "fuel_inventory": [{"name": "coal", "count": 24}],
  "fluid_boxes": [
    {"index": 1, "type": "water_input", "fluid": null, "amount": 0, "connected": false},
    {"index": 2, "type": "steam_output", "fluid": null, "amount": 0, "connected": true, "connected_to": {"name": "steam-engine", "position": {"x": -13.5, "y": -44.5}}}
  ],
  "recipe": null,
  "output_inventory": []
}
```
Key fields: `status` (human-readable string like `"no_fluid"`, `"no_power"`, `"working"`, `"no_fuel"`), `fluid_boxes` with connection info, and all inventory contents.

Should support `--target` lists and `--targets-json` for batch inspection, consistent with other commands.

---

## Problem 3: Entity Placement Errors Are Opaque

### What happened
The agent spent ~30% of the session trying to place a boiler next to an offshore pump. Every failed attempt returned the same unhelpful error: `"Placement blocked: collision or invalid position"`. The agent couldn't determine whether it was overlapping another entity, placing on water, misaligned to a grid, or simply too far from a connection point. This led to brute-force trial-and-error across dozens of positions and directions.

### Current response
```json
{"name": "boiler", "x": -14, "y": -49, "ok": false, "error": "Placement blocked: collision or invalid position"}
```

### Proposed fix
Return a structured error with the specific reason:
```json
{"name": "boiler", "x": -14, "y": -49, "ok": false, "error": "collision", "detail": "Overlaps existing entity", "blocking_entity": {"name": "offshore-pump", "position": {"x": -14.5, "y": -51.5}}}
```
```json
{"name": "boiler", "x": -20, "y": -52, "ok": false, "error": "invalid_terrain", "detail": "Cannot place on water", "tile": "deepwater"}
```

Also, on successful placement, return the **actual entity center position** so the caller knows where the entity ended up:
```json
{"name": "boiler", "x": -14, "y": -48, "ok": true, "actual_position": {"x": -13.5, "y": -48}, "direction": 0}
```

---

## Problem 4: act-extract Fails on Count Mismatch

### What happened
When extracting smelted plates from furnaces, `act-extract --count 50` fails entirely if only 10 plates are available. The agent had to either know exact counts in advance or handle errors and retry with the correct count. For batch extraction across 20+ furnaces, this doubled the number of API calls needed.

### Current behavior
```json
{"ok": false, "error": "count too high: requested 50 but only 10 available", "available": 10, "requested": 50}
```

### Proposed fix
Support `all` as a value for `--count` to extract everything of that item type:
```
factorio act-extract --entity 2,0 --item iron-plate --count all
```
```json
{"ok": true, "removed": 10, "inserted": 10}
```

---

## Problem 5: No Resource Scan

### What happened
Finding ore patches required 8+ `observe-world` calls at various offsets with radius 50-60, each returning ~300KB of tile data. The agent had to parse thousands of tile entries in Python to aggregate resource locations. Even then, it might have missed patches outside the scanned area.

### Proposed fix
Add `observe-resources` that scans for resource patches:
```
factorio observe-resources --radius 200
```
```json
{
  "patches": [
    {"resource": "coal", "center": {"x": 68, "y": 32}, "tile_count": 374, "bounds": {"min_x": 55, "min_y": 21, "max_x": 81, "max_y": 43}},
    {"resource": "iron-ore", "center": {"x": 43, "y": 105}, "tile_count": 781, "bounds": {"min_x": 26, "min_y": 88, "max_x": 60, "max_y": 121}},
    {"resource": "copper-ore", "center": {"x": 155, "y": -21}, "tile_count": 98, "bounds": {"min_x": 149, "min_y": -25, "max_x": 161, "max_y": -16}},
    {"resource": "stone", "center": {"x": 22, "y": 92}, "tile_count": 197, "bounds": {"min_x": 14, "min_y": 84, "max_x": 29, "max_y": 100}}
  ]
}
```

This replaces 8+ slow calls with 1 fast call and removes the need for client-side aggregation.

---

## Problem 6: No Entity Prototype Info

### What happened
The agent didn't know entity dimensions (is a boiler 2x3 or 3x2?), where fluid connection points are, or how rotation affects connections. This information is essential for planning layouts but isn't exposed anywhere in the CLI. The agent had to reverse-engineer this through trial-and-error placement and RCON Lua introspection.

### Proposed fix
Add `observe-entity-prototype --name <entity-name>`:
```
factorio observe-entity-prototype --name boiler
```
```json
{
  "name": "boiler",
  "size": {"width": 2, "height": 3},
  "fluid_boxes": [
    {"index": 1, "type": "input", "pipe_connections": [
      {"direction": "west", "position": {"x": -1, "y": 0.5}},
      {"direction": "east", "position": {"x": 1, "y": 0.5}}
    ]},
    {"index": 2, "type": "output", "pipe_connections": [
      {"direction": "north", "position": {"x": 0, "y": -1.5}}
    ]}
  ],
  "energy_source": "burner",
  "fuel_categories": ["chemical"]
}
```
Positions should be relative to entity center when facing north (direction=0). The caller can rotate them to match the actual placement direction.

---

## Problem 7: Malformed JSON in observe-player

### What happened
`observe-player` returns non-standard JSON with extra/trailing commas:
```json
{"player":{,"name":"RyMad",,"x":0,,"y":0,,
```
The agent had to write regex cleanup (`re.sub(r',(\s*,)+', ',', s)` etc.) before parsing. Every other command returns valid JSON.

### Proposed fix
Fix the serialization in `observe-player` to emit valid JSON. This is likely a bug in string concatenation or a template that unconditionally adds commas between optional fields.

---

## Problem 8: Coordinate System Confusion

### What happened
`act-build --entity pipe,-14,-50` places a pipe, but `observe-world` reports it at position `(-13.5, -49.5)`. The input uses tile coordinates but the output uses entity center coordinates (offset by +0.5 for 1x1 entities, variable for larger entities). The agent wasted significant effort because pipe at "(-14, -50)" and pump at "(-14.5, -51.5)" appeared adjacent on input but were actually 1.5 tiles apart.

### Proposed fix
**Normalize all coordinates to tile coordinates** matching the input format. Entity positions in `observe-world`, `observe-entity`, and `act-build` responses should use the same tile coordinate system that `act-build`, `act-mine`, `act-insert`, and `act-extract` accept as input. If a pipe is placed with `--entity pipe,-14,-50,0`, it should appear at `(-14, -50)` everywhere — not `(-13.5, -49.5)`.
