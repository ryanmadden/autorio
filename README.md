# autorio

Factorio headless-server manager and JSON CLI for evaluating game-playing agents.

The JSON API and CLI currently use schema version 2. There is no v1 compatibility
layer.

The CLI is available in both Node.js and dependency-free Python 3.10+ forms.
They use the same commands, flags, JSON output, and `FACTORIO_API_BASE` setting:

```bash
npm run build
node dist/agent-cli.js server-status
python3 factorio.py server-status
```

The same file is importable for scripts without spawning a subprocess:

```python
from factorio import FactorioClient, action_job_ok, data_value

client = FactorioClient()
player = data_value(client.observe_player())["player"]
job = client.move([{"x": player["x"] + 1, "y": player["y"]}])
assert action_job_ok(job)
```

Actions wait for completion by default. Pass `detach=True` and optionally an
`idempotency_key` to use the job API asynchronously. Run the dependency-free
Python test suite with `python3 -m unittest discover -s tests -v`.
Manager operations are also available as `create_save()`, `save_active_game()`,
`server_start()`, and `server_stop()`.

Set `AUTORIO_PORT` to run the HTTP service on a port other than `3000`.

The manager UI can create named saves with
`factorio/data/map-gen-settings.json`, start or stop a selected save, and save
the active game through RCON. The corresponding endpoints are `POST /api/saves`
with `{ "name": "new-save" }` and `POST /api/server/save`.

## Useful commands

`./bin/x64/factorio --create saves/<save_name>.zip --map-gen-settings data/map-gen-settings.json`

## Vanilla-compatible evaluation controls

`observe-map` exposes only chunks charted by the player's force:

```bash
factorio observe-map --center-x 0 --center-y 0 --radius 96
```

The server uses only vanilla RCON commands, so unmodded clients can spectate.
Movement remains a time-accounted abstraction because vanilla RCON has no
persistent per-tick input hook; placement uses the real player cursor/build API.

## Coordinates

Build coordinates are explicit top-left tile anchors. For example:

```bash
factorio act-build --entity boiler,-14,-50,4
```

Build and placement responses distinguish `requested_anchor`, `intended_center`,
`actual_center`, and `occupied_tiles`. Entity observations similarly distinguish
the queried tile from the entity center. Prototype observations report tile size
and whether an entity center aligns to integer or half-tile coordinates.

## Action jobs

All state-changing agent operations are serialized through jobs. The CLI creates
a job and polls it by default:

```bash
factorio act-mine --target 10,12 --resource iron-ore
```

Use `--detach` to return the job immediately, then inspect or cancel it:

```bash
factorio act-build --detach --idempotency-key build-smelters-1 \
  --entity stone-furnace,10,10,0
factorio job-status --job-id <id>
factorio job-cancel --job-id <id>
```

Jobs are in-memory, retained for one hour, and run one at a time so concurrent
clients cannot race the player character. Cancellation takes effect between
atomic actions; an action already executing in Factorio is not rolled back.

Direct calls to `/api/agent/act/*` are rejected. Submit `{action, payload}` to
`POST /api/agent/jobs`, poll `GET /api/agent/jobs/:id`, and request cancellation
with `POST /api/agent/jobs/:id/cancel`.

## Planning and observation

- `observe-placement` performs a read-only placement check and returns footprint,
  reach, terrain, possible blockers, and nearby valid anchors.
- `observe-entity-prototype` reports Factorio 2.x prototype geometry, placement
  alignment, energy source, and directional fluid connection definitions.
- `observe-entity` reports semantic, deduplicated inventories and absolute fluid
  connection and target positions.
- `observe-research` includes science packs, unit count/time, prerequisites,
  missing prerequisites, and available, locked, queued, current, and completed
  technologies.
- `observe-world` returns charted terrain as run-length encoded rows.
- `observe-resources` returns charted connected-component patches, nearest-patch
  summaries, and shoreline candidates instead of individual resource entities.
