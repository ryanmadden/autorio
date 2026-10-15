#!/usr/bin/env python3
"""Python client for the autorio Factorio JSON API.

This intentionally mirrors src/agent-cli.ts so agents can use the same command
line interface without requiring Node.js.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_BASE = os.environ.get("FACTORIO_API_BASE", "http://localhost:3000")
API_SCHEMA_VERSION = 2
POLL_INTERVAL_SECONDS = 0.25
MISSING = object()

__all__ = [
    "FactorioClient",
    "action_job_ok",
    "compact",
    "data_value",
    "http_request",
    "parse_entities",
    "parse_targets",
    "submit_action_job",
]


GLOBAL_USAGE = """factorio.py <command> [options]

Commands:
  server-status
  server-start --save <name>.zip
  server-stop
  server-saves
  observe-world --window-x <n> --window-y <n> --radius <n> --include terrain,entities
  observe-map --center-x <n> --center-y <n> --radius <n>
  observe-player --limit-inventory <n> --limit-equipment <n>
  observe-research --limit-available <n> --limit-locked <n> --limit-completed <n>
  observe-recipes --limit-recipes <n> [--unlocked-only]
  observe-entity --target x,y [--target ...] [--targets-json <json>]
  observe-resources --window-x <n> --window-y <n> --radius <n>
  observe-entity-prototype --name <entity-name>
  observe-placement --entity name,anchor-x,anchor-y,dir [--entity ...]
  act-build --entity name,anchor-x,anchor-y,dir [--entity ...]
  act-mine --target x,y [--target ...] [--resource [name]] [--targets-json <json>]
  act-rotate --target x,y [--target ...] [--targets-json <json>]
  act-move --target x,y [--target ...] [--targets-json <json>]
  act-set-recipe --target x,y,recipe [--target ...] [--targets-json <json>]
  act-research --technology <name>
  act-craft --item <name> --count <n>
  act-insert --entity x,y --item <name> --count <n>
  act-extract --entity x,y --item <name> --count <n|all>
  wait --ms <n>
  job-status --job-id <id>
  job-cancel --job-id <id>

Notes:
  - This CLI is intended for AI agents playing Factorio headlessly (no visual UI).
  - Actions that require the player to be near a target (build/mine/rotate/insert/extract/set-recipe)
    are NOT instant. The server simulates walking time based on distance before the action completes.

Global options:
  --base <url> (default: FACTORIO_API_BASE or http://localhost:3000)
  --detach (return immediately after creating an action job)
  --idempotency-key <key> (safely retry action submission)
  --help

More help:
  Run: factorio.py <command> --help
"""


COMMAND_USAGE = {
    "server-status": "server-status: Show whether the server is running and RCON is connected.\nUsage: factorio.py server-status\n",
    "server-start": "server-start: Launch the headless server with the given save.\nUsage: factorio.py server-start --save <name>.zip\n",
    "server-stop": "server-stop: Stop the running server (saves and exits).\nUsage: factorio.py server-stop\n",
    "server-saves": "server-saves: List available save files on the server.\nUsage: factorio.py server-saves\n",
    "observe-world": "observe-world: Fetch compact RLE terrain and entities in a charted window.\nUsage: factorio.py observe-world --window-x <n> --window-y <n> --radius <n> --include terrain,entities\n",
    "observe-map": "observe-map: Read a player-charted map window; uncharted chunks are masked.\nUsage: factorio.py observe-map --center-x <n> --center-y <n> --radius <n>\n",
    "observe-player": "observe-player: Inspect player position, health, inventories, and equipment.\nUsage: factorio.py observe-player --limit-inventory <n> --limit-equipment <n>\n",
    "observe-research": "observe-research: Get current, queued, available, locked, and completed technologies with costs.\nUsage: factorio.py observe-research --limit-available <n> --limit-locked <n> --limit-completed <n>\n",
    "observe-recipes": "observe-recipes: List available recipes and their ingredients/products.\nUsage: factorio.py observe-recipes --limit-recipes <n> [--unlocked-only]\n",
    "observe-entity": "observe-entity: Inspect entity status, fuel, fluids, recipe, inventory.\nUsage: factorio.py observe-entity --target x,y [--target ...]\n   or: factorio.py observe-entity --targets-json <json>\n",
    "observe-resources": "observe-resources: Scan for resource patches in a radius.\nUsage: factorio.py observe-resources --window-x <n> --window-y <n> --radius <n>\n",
    "observe-entity-prototype": "observe-entity-prototype: Look up entity dimensions, fluid connections, energy info.\nUsage: factorio.py observe-entity-prototype --name <entity-name>\n",
    "observe-placement": "observe-placement: Analyze buildability without consuming an item.\nUsage: factorio.py observe-placement --entity name,anchor-x,anchor-y,dir [--entity ...]\n",
    "act-build": "act-build: Place entities using the top-left occupied tile as the anchor.\nUsage: factorio.py act-build --entity name,anchor-x,anchor-y,dir [--entity ...]\n   or: factorio.py act-build --entities-json <json>\nDirection: 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nNote: This action includes simulated walking time based on distance.\n",
    "act-mine": "act-mine: Mine a resource or entity at target tile coordinates.\nUsage: factorio.py act-mine --target x,y [--target ...] [--resource [name]]\n   or: factorio.py act-mine --targets-json <json>\nResource mode excludes the character and prioritizes the requested resource deterministically.\nNote: This action includes simulated walking time based on distance, plus ~2s per item mined.\n",
    "act-rotate": "act-rotate: Rotate entities at target tile coordinates (first entity at each point).\nUsage: factorio.py act-rotate --target x,y [--target ...]\n   or: factorio.py act-rotate --targets-json <json>\nDirection (in results): 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nNote: This action includes simulated walking time based on distance.\n",
    "act-move": "act-move: Move the player through paced, collision-checked steps to target tile coordinates.\nUsage: factorio.py act-move --target x,y [--target ...]\n   or: factorio.py act-move --targets-json <json>\nNote: Stops and returns partial progress if an intermediate step is blocked.\n",
    "act-set-recipe": "act-set-recipe: Set the recipe on assemblers at target tile coordinates.\nUsage: factorio.py act-set-recipe --target x,y,recipe [--target ...]\n   or: factorio.py act-set-recipe --targets-json <json>\nNote: This action includes simulated walking time based on distance.\n",
    "act-research": "act-research: Start researching a technology.\nUsage: factorio.py act-research --technology <name>\n",
    "act-craft": "act-craft: Start crafting a recipe in the player's crafting queue.\nUsage: factorio.py act-craft --item <name> --count <n>\n",
    "act-insert": "act-insert: Move items from player inventory into an entity at x,y.\nUsage: factorio.py act-insert --entity x,y --item <name> --count <n>\nNote: This action includes simulated walking time based on distance.\n",
    "act-extract": "act-extract: Remove items from an entity at x,y into player inventory.\nUsage: factorio.py act-extract --entity x,y --item <name> --count <n|all>\nNote: This action includes simulated walking time based on distance.\n",
    "wait": "wait: Sleep locally for N milliseconds between actions.\nUsage: factorio.py wait --ms <n>\n",
    "job-status": "job-status: Read action job progress.\nUsage: factorio.py job-status --job-id <id>\n",
    "job-cancel": "job-cancel: Request cancellation after the current atomic action.\nUsage: factorio.py job-cancel --job-id <id>\n",
}


@dataclass
class ParsedArgs:
    base: str
    command: str | None
    flags: dict[str, list[str]] = field(default_factory=dict)
    positionals: list[str] = field(default_factory=list)


def parse_args(argv: list[str]) -> ParsedArgs:
    flags: dict[str, list[str]] = {}
    positionals: list[str] = []
    base = DEFAULT_BASE
    saw_help = False
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--help":
            saw_help = True
            index += 1
            continue
        if arg.startswith("--"):
            raw = arg[2:]
            if "=" in raw:
                key, value = raw.split("=", 1)
            else:
                key = raw
                if index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                    index += 1
                    value = argv[index]
                else:
                    value = "true"
            if key == "base":
                base = value
            else:
                flags.setdefault(key, []).append(value)
            index += 1
            continue
        positionals.append(arg)
        index += 1

    command = positionals.pop(0) if positionals else None
    if saw_help:
        help_args = ([command] if command else []) + positionals
        return ParsedArgs(base, "help", flags, help_args)
    return ParsedArgs(base, command, flags, positionals)


def get_flag(flags: dict[str, list[str]], name: str) -> str | None:
    values = flags.get(name)
    return values[-1] if values else None


def parse_number(value: str | None, fallback: int | float | None = None) -> int | float | None:
    if value is None:
        return fallback
    try:
        number = float(value.strip()) if value.strip() else 0.0
    except ValueError:
        return fallback
    if not math.isfinite(number):
        return fallback
    return int(number) if number.is_integer() else number


def parse_entities(values: list[str]) -> list[dict[str, Any]]:
    entities = []
    for entry in values:
        parts = [part.strip() for part in entry.split(",")]
        name = parts[0] if parts else ""
        x = parse_number(parts[1], None) if len(parts) > 1 else None
        y = parse_number(parts[2], None) if len(parts) > 2 else None
        direction = parse_number(parts[3], None) if len(parts) > 3 else None
        if not name or x is None or y is None:
            raise ValueError(f"Invalid --entity '{entry}'")
        if len(parts) > 3 and direction is None:
            raise ValueError(f"Invalid --entity direction in '{entry}'")
        entity: dict[str, Any] = {"name": name, "anchor": {"x": x, "y": y}}
        if len(parts) > 3:
            entity["direction"] = direction
        entities.append(entity)
    return entities


def parse_targets(values: list[str], require_recipe: bool) -> list[dict[str, Any]]:
    targets = []
    for entry in values:
        parts = [part.strip() for part in entry.split(",")]
        x = parse_number(parts[0], None) if parts else None
        y = parse_number(parts[1], None) if len(parts) > 1 else None
        recipe = parts[2] if len(parts) > 2 else ""
        if x is None or y is None:
            raise ValueError(f"Invalid --target '{entry}'")
        if require_recipe and not recipe:
            raise ValueError(f"Missing recipe in --target '{entry}'")
        target: dict[str, Any] = {"x": x, "y": y}
        if require_recipe:
            target["recipe"] = recipe
        targets.append(target)
    return targets


def compact(value: Any) -> Any:
    """Recursively omit None values to match JSON.stringify(undefined fields)."""
    if isinstance(value, dict):
        return {key: compact(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [compact(item) for item in value]
    return value


def http_request(base: str, method: str, path: str, body: Any = None) -> Any:
    encoded = None
    headers: dict[str, str] = {}
    if body is not None:
        encoded = json.dumps(compact(body), separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(f"{base}{path}", data=encoded, headers=headers, method=method)
    try:
        with urlopen(request) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = raw
        if isinstance(payload, dict) and payload.get("error"):
            raise RuntimeError(str(payload["error"])) from error
        raise RuntimeError(f"HTTP {error.code}") from error
    try:
        return json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return raw


class FactorioClient:
    """Synchronous Python client for the Factorio manager API.

    Observation methods return the server response envelope so callers retain
    metadata such as ``truncated``. Action methods return the action job. By
    default they wait for a terminal job state; pass ``detach=True`` to return
    immediately after submission.
    """

    def __init__(self, base_url: str = DEFAULT_BASE, *, poll_interval: float = POLL_INTERVAL_SECONDS):
        self.base_url = base_url.rstrip("/")
        self.poll_interval = max(0.0, float(poll_interval))

    def request(self, method: str, path: str, body: Any = None) -> Any:
        return http_request(self.base_url, method, path, body)

    def server_status(self) -> Any:
        return self.request("GET", "/api/server/status")

    def server_saves(self) -> Any:
        return self.request("GET", "/api/saves")

    def create_save(self, name: str) -> Any:
        return self.request("POST", "/api/saves", {"name": name})

    def save_active_game(self) -> Any:
        return self.request("POST", "/api/server/save")

    def server_start(self, save: str) -> Any:
        return self.request("POST", "/api/server/start", {"save": save})

    def server_stop(self) -> Any:
        return self.request("POST", "/api/server/stop")

    def observe_world(self, *, x: float = 0, y: float = 0, radius: float = 12,
                      include: list[str] | None = None) -> Any:
        return self.request("POST", "/api/agent/observe/world", {
            "window": {"x": x, "y": y, "radius": radius},
            "include": include or ["terrain", "entities"],
        })

    def observe_map(self, *, x: float = 0, y: float = 0, radius: float = 48) -> Any:
        return self.request("POST", "/api/agent/observe/map", {
            "window": {"x": x, "y": y, "radius": radius},
        })

    def observe_player(self, *, inventory_slots: int | None = None,
                       equipment_slots: int | None = None) -> Any:
        return self.request("POST", "/api/agent/observe/player", {"limits": {
            "inventory_slots": inventory_slots,
            "equipment_slots": equipment_slots,
        }})

    def observe_research(self, *, available: int | None = None,
                         locked: int | None = None,
                         completed: int | None = None) -> Any:
        return self.request("POST", "/api/agent/observe/research", {"limits": {
            "available": available,
            "locked": locked,
            "completed": completed,
        }})

    def observe_recipes(self, *, recipes: int | None = None,
                        unlocked_only: bool = False) -> Any:
        return self.request("POST", "/api/agent/observe/recipes", {
            "limits": {"recipes": recipes},
            "filters": {"unlocked": True} if unlocked_only else None,
        })

    def observe_entities(self, targets: list[dict[str, Any]]) -> Any:
        return self.request("POST", "/api/agent/observe/entity", {"targets": targets})

    def observe_resources(self, *, x: float = 0, y: float = 0,
                          radius: float = 50) -> Any:
        return self.request("POST", "/api/agent/observe/resources", {
            "window": {"x": x, "y": y, "radius": radius},
        })

    def observe_entity_prototype(self, name: str) -> Any:
        return self.request("POST", "/api/agent/observe/entity-prototype", {"name": name})

    def observe_placement(self, placements: list[dict[str, Any]]) -> Any:
        return self.request("POST", "/api/agent/observe/placement", {"placements": placements})

    def submit_action(self, action: str, payload: Any, *, detach: bool = False,
                      idempotency_key: str | None = None,
                      timeout: float | None = None) -> Any:
        job = self.request("POST", "/api/agent/jobs", {
            "action": action,
            "payload": payload,
            "idempotency_key": idempotency_key,
        })
        if detach:
            return job
        job_id = job.get("job_id") if isinstance(job, dict) else None
        if not job_id:
            raise RuntimeError("Server did not return a job ID")
        return self.wait_for_job(str(job_id), timeout=timeout, initial=job)

    def wait_for_job(self, job_id: str, *, timeout: float | None = None,
                     initial: Any = None) -> Any:
        started = time.monotonic()
        job = initial if initial is not None else self.job_status(job_id)
        while isinstance(job, dict) and job.get("status") in ("queued", "running"):
            if timeout is not None and time.monotonic() - started >= timeout:
                raise TimeoutError(f"Timed out waiting for job {job_id}")
            time.sleep(self.poll_interval)
            job = self.job_status(job_id)
        return job

    def job_status(self, job_id: str) -> Any:
        encoded_id = quote(str(job_id), safe="-_.!~*'()")
        return self.request("GET", f"/api/agent/jobs/{encoded_id}")

    def job_cancel(self, job_id: str) -> Any:
        encoded_id = quote(str(job_id), safe="-_.!~*'()")
        return self.request("POST", f"/api/agent/jobs/{encoded_id}/cancel")

    def build(self, entities: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("build", {"entities": entities}, **options)

    def mine(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("mine", {"targets": targets}, **options)

    def rotate(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("rotate", {"targets": targets}, **options)

    def move(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("move", {"targets": targets}, **options)

    def set_recipe(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("set-recipe", {"targets": targets}, **options)

    def research(self, technology: str, **options: Any) -> Any:
        return self.submit_action("research", {"technology": technology}, **options)

    def craft(self, item: str, count: int = 1, **options: Any) -> Any:
        return self.submit_action("craft", {"item": item, "count": count}, **options)

    def insert(self, entity: dict[str, float], item: str, count: int = 1,
               **options: Any) -> Any:
        return self.submit_action("insert", {
            "entity": entity, "item": item, "count": count,
        }, **options)

    def extract(self, entity: dict[str, float], item: str,
                count: int | str = 1, **options: Any) -> Any:
        return self.submit_action("extract", {
            "entity": entity, "item": item, "count": count,
        }, **options)


def submit_action_job(base: str, action: str, payload: Any, detach: bool, idempotency_key: str | None) -> Any:
    job = http_request(
        base,
        "POST",
        "/api/agent/jobs",
        {"action": action, "payload": payload, "idempotency_key": idempotency_key},
    )
    if detach:
        return job
    job_id = job.get("job_id") if isinstance(job, dict) else None
    if not job_id:
        raise RuntimeError("Server did not return a job ID")
    while isinstance(job, dict) and job.get("status") in ("queued", "running"):
        time.sleep(POLL_INTERVAL_SECONDS)
        encoded_id = quote(str(job_id), safe="-_.!~*'()")
        job = http_request(base, "GET", f"/api/agent/jobs/{encoded_id}")
    return job


def action_job_ok(job: Any) -> bool:
    if not isinstance(job, dict):
        return False
    if job.get("status") in ("failed", "cancelled"):
        return False
    if job.get("status") in ("queued", "running"):
        return True
    results = job.get("results")
    return isinstance(results, list) and bool(results) and all(
        isinstance(result, dict) and result.get("ok") is not False for result in results
    )


def parse_json_if_string(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def data_value(response: Any) -> Any:
    if isinstance(response, dict) and response.get("data") is not None:
        return response["data"]
    return response


def write_response(*, ok: bool, cmd: str, started: float, data: Any = MISSING,
                   error: str | None = None, truncated: Any = MISSING) -> None:
    response: dict[str, Any] = {"schema_version": API_SCHEMA_VERSION, "ok": ok, "cmd": cmd}
    if data is not MISSING:
        response["data"] = data
    if error is not None:
        response["error"] = error
    if truncated is not MISSING:
        response["truncated"] = truncated
    response["timing_ms"] = int((time.monotonic() - started) * 1000)
    print(json.dumps(response, separators=(",", ":"), ensure_ascii=False))


def run(argv: list[str]) -> int:
    started = time.monotonic()
    parsed = parse_args(argv)
    if not parsed.command:
        sys.stderr.write(GLOBAL_USAGE)
        return 1
    if parsed.command == "help":
        command = parsed.positionals[0] if parsed.positionals else None
        sys.stderr.write(COMMAND_USAGE.get(command, GLOBAL_USAGE))
        return 0

    cmd = parsed.command
    flag = lambda name: get_flag(parsed.flags, name)
    flags = parsed.flags

    def request(method: str, path: str, body: Any = None) -> Any:
        return http_request(parsed.base, method, path, body)

    def submit(action: str, payload: Any) -> Any:
        return submit_action_job(
            parsed.base,
            action,
            payload,
            detach=bool(flag("detach")),
            idempotency_key=flag("idempotency-key"),
        )

    def output(data: Any, *, ok: bool = True, truncated: Any = MISSING) -> int:
        write_response(ok=ok, cmd=cmd, data=data, truncated=truncated, started=started)
        return 0 if ok else 1

    try:
        if cmd == "server-status":
            return output(request("GET", "/api/server/status"))
        if cmd == "server-start":
            save = flag("save")
            if not save:
                raise ValueError("Missing --save")
            return output(request("POST", "/api/server/start", {"save": save}))
        if cmd == "server-stop":
            return output(request("POST", "/api/server/stop"))
        if cmd == "server-saves":
            return output(request("GET", "/api/saves"))

        if cmd == "observe-world":
            include = [part.strip() for part in (flag("include") or "").split(",") if part.strip()]
            response = request("POST", "/api/agent/observe/world", {
                "window": {
                    "x": parse_number(flag("window-x"), 0),
                    "y": parse_number(flag("window-y"), 0),
                    "radius": parse_number(flag("radius"), 12),
                },
                "include": include or ["terrain", "entities"],
            })
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-map":
            response = request("POST", "/api/agent/observe/map", {"window": {
                "x": parse_number(flag("center-x"), 0),
                "y": parse_number(flag("center-y"), 0),
                "radius": parse_number(flag("radius"), 48),
            }})
            return output(data_value(response))
        if cmd == "observe-player":
            response = request("POST", "/api/agent/observe/player", {"limits": {
                "inventory_slots": parse_number(flag("limit-inventory")),
                "equipment_slots": parse_number(flag("limit-equipment")),
            }})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-research":
            response = request("POST", "/api/agent/observe/research", {"limits": {
                "available": parse_number(flag("limit-available")),
                "locked": parse_number(flag("limit-locked")),
                "completed": parse_number(flag("limit-completed")),
            }})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-recipes":
            response = request("POST", "/api/agent/observe/recipes", {
                "limits": {"recipes": parse_number(flag("limit-recipes"))},
                "filters": {"unlocked": True} if flag("unlocked-only") else None,
            })
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(parse_json_if_string(data_value(response)), truncated=truncated)
        if cmd == "observe-entity":
            targets = json.loads(flag("targets-json")) if flag("targets-json") else parse_targets(flags.get("target", []), False)
            response = request("POST", "/api/agent/observe/entity", {"targets": targets})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-resources":
            response = request("POST", "/api/agent/observe/resources", {"window": {
                "x": parse_number(flag("window-x"), 0),
                "y": parse_number(flag("window-y"), 0),
                "radius": parse_number(flag("radius"), 50),
            }})
            return output(data_value(response))
        if cmd == "observe-entity-prototype":
            name = flag("name")
            if not name:
                raise ValueError("Missing --name")
            return output(data_value(request("POST", "/api/agent/observe/entity-prototype", {"name": name})))
        if cmd == "observe-placement":
            placements = json.loads(flag("entities-json")) if flag("entities-json") else parse_entities(flags.get("entity", []))
            response = request("POST", "/api/agent/observe/placement", {"placements": placements})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)

        if cmd == "act-build":
            entities = json.loads(flag("entities-json")) if flag("entities-json") else parse_entities(flags.get("entity", []))
            job = submit("build", {"entities": entities})
        elif cmd in ("act-mine", "act-rotate", "act-move", "act-set-recipe"):
            require_recipe = cmd == "act-set-recipe"
            targets = json.loads(flag("targets-json")) if flag("targets-json") else parse_targets(flags.get("target", []), require_recipe)
            if cmd == "act-mine" and flag("resource"):
                resource = flag("resource")
                targets = [dict(target, kind="resource", **({} if resource == "true" else {"name": resource})) for target in targets]
            action = {"act-mine": "mine", "act-rotate": "rotate", "act-move": "move", "act-set-recipe": "set-recipe"}[cmd]
            job = submit(action, {"targets": targets})
        elif cmd == "act-research":
            technology = flag("technology")
            if not technology:
                raise ValueError("Missing --technology")
            job = submit("research", {"technology": technology})
        elif cmd == "act-craft":
            item = flag("item")
            if not item:
                raise ValueError("Missing --item")
            job = submit("craft", {"item": item, "count": parse_number(flag("count"), 1)})
        elif cmd in ("act-insert", "act-extract"):
            entity_value = flag("entity")
            item = flag("item")
            if not entity_value:
                raise ValueError("Missing --entity")
            if not item:
                raise ValueError("Missing --item")
            target = parse_targets([entity_value], False)[0]
            raw_count = flag("count")
            count: Any = "all" if cmd == "act-extract" and raw_count == "all" else parse_number(raw_count, 1)
            job = submit(cmd.removeprefix("act-"), {"entity": target, "item": item, "count": count})
        elif cmd == "wait":
            milliseconds = max(0, parse_number(flag("ms"), 0) or 0)
            time.sleep(milliseconds / 1000)
            return output({"waited_ms": milliseconds})
        elif cmd == "job-status":
            job_id = flag("job-id")
            if not job_id:
                raise ValueError("Missing --job-id")
            encoded_id = quote(job_id, safe="-_.!~*'()")
            job = request("GET", f"/api/agent/jobs/{encoded_id}")
        elif cmd == "job-cancel":
            job_id = flag("job-id")
            if not job_id:
                raise ValueError("Missing --job-id")
            encoded_id = quote(job_id, safe="-_.!~*'()")
            return output(request("POST", f"/api/agent/jobs/{encoded_id}/cancel"))
        else:
            raise ValueError(f"Unknown command '{cmd}'")

        return output(job, ok=action_job_ok(job))
    except Exception as error:  # Keep failures machine-readable like the TypeScript CLI.
        write_response(ok=False, cmd=cmd, error=str(error) or "Command failed", started=started)
        return 1


def main() -> None:
    raise SystemExit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
