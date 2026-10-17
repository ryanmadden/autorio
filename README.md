# autorio

A macOS scaffold for running visible Factorio games, launching Codex agents through
an importable Python library, and recording comparable playthroughs. The full game
hosts a private local multiplayer session, providing both the player character and
RCON in one graphical process. No second computer or dedicated-server installation
is required. OBS can automatically capture run timelapses (see below).

## First run

Requirements: macOS, the full Factorio game (tested with Steam 2.0.77 on Apple
Silicon), Node.js 22+, Python 3, and a logged-in Codex CLI. Open Steam and sign in
before launching a game. The demo is not supported.

```bash
npm ci
npm run build
./autorio start smoke
```

`./autorio` finds Node on PATH, in standard Homebrew locations, or in the bundled
Codex runtime on this machine. It rebuilds changed TypeScript automatically. You
can also use `npm run run -- start smoke` after building. The manager starts
automatically and remains available after the run. `./autorio shutdown` stops an
active run and closes the manager; use it before restarting with changed code.

The smoke benchmark asks Codex to craft one gear. It verifies the entire launch,
Python action, production recording, final-save, and shutdown path. For a real
factory task or the full game:

```bash
./autorio start automation --model YOUR_MODEL
./autorio start rocket --model YOUR_MODEL --seconds 28800
./autorio start smoke --manual --detach
./autorio list
./autorio watch RUN_ID
./autorio stop RUN_ID
./autorio compare RUN_ID RUN_ID
./autorio shutdown
```

Use an explicit model for comparisons. With no `--model`, Codex uses its default;
the runner ignores personal Codex configuration to reduce variation. It uses
`codex exec`, a workspace-write sandbox with network access so Python can
reach localhost, and existing CLI authentication. `CODEX_BIN` selects another
installed CLI. No approval/sandbox bypass flag is used.

Codex runs open the web recording view by default. It displays agent messages and
available reasoning summaries, with consecutive commands grouped into collapsed
“Ran N commands” rows. Expand a row to inspect commands and their full output;
failed commands are marked in the summary. Words come from Codex's structured
`codex exec --json` events. No dashboard panels, setup messages, or shell prompt
are added. Reasoning summaries appear only when emitted by the selected model.
It follows new output unless you scroll up. The standalone recording window
automatically closes two seconds after completion, failure, stop, timeout, or interruption.
The manager opens a dedicated macOS window containing the web recording view,
with no browser tabs or address bar. Both dashboard and CLI launches use it.
Closing it manually does not stop the run. You can reopen saved output using
the dashboard’s Recording view link, which stays open in the browser.
`--detach` prints the URL without opening a window; `--watch` follows operator logs here.

Exact structured output is saved in `agent.events.jsonl`; separate
`agent.stdout.log` and `agent.stderr.log` files are also retained. Older saved runs
keep their original display. Closing the view does not stop the benchmark.
Use `./autorio stop RUN_ID` to stop it.

Use `--terminal` (or `AUTORIO_TERMINAL=1`) for the optional macOS Terminal viewer.
This CLI-only mode uses native human output,
saved verbatim in `codex.log`. That viewer runs directly without an
interactive shell and closes two seconds after the run ends. Default Terminal
settings and other windows are unaffected.

Ctrl-C while watching in the invoking terminal requests a stop and final save.
`--detach` leaves the run active. `--manual` prepares the same game and telemetry
without launching an agent; use `factorio.py` against the manager for debugging. A run ends when its
objective is independently observed, its time limit expires, the operator stops
it, or the agent/game/telemetry fails. An agent's success claim or zero exit code
alone does not count as completion. Runs do not automatically resume after a
manager restart; unfinished records become `interrupted`. Stop any surviving game
with `python3 factorio.py server-stop` before starting a replacement run.

Open [the runs dashboard](http://127.0.0.1:3000/) to launch runs and monitor the
current run's progress. Click a run in the history to open its Run Details page:
configuration, token counts, milestones, production graph, and live activity.
Select multiple history rows to compare runs on a separate page. Recording view
remains a compact, separate display. Old `/runs.html` bookmarks redirect to the
appropriate page. Position the game and recording window for OBS yourself.

## Benchmarks and results

`benchmarks/*.json` defines tasks, map generation settings and seed, explicit
starting items, daylight policy, time limits, sampling intervals, and milestones.
The initial profiles use base Factorio only (Space Age, Quality, and Elevated
Rails disabled), enemy-base generation disabled (peaceful mode retained as a
fallback), seed 424242, and permanent daylight set to noon. `smoke` is an
integration check; `automation` requires twenty new iron plates; `rocket` requires
an actual rocket launch. Production thresholds prove output, rather than a
particular factory design or sustained throughput.

The manager caches a baseline ZIP keyed by game version and map settings, then
copies it for each run. Startup is excluded from scoring. Wall-clock time begins
when the configured game is ready and the agent is launched. Both agent thinking
and API execution time count. Game ticks are recorded separately; the game runs
at speed 1. Milestone times are first-observed times, with precision bounded by
the benchmark's polling interval. Human input can affect a run: leave the game
alone while comparing agents. Pauses and performance changes remain visible in
the wall-clock/game-tick measurements.

Everything generated is ignored by Git under `.autorio/`:

```text
.autorio/
  baselines/<hash>/baseline.zip
  manager.log
  runs/<run-id>/
    run.json                  # state, result, versions, hashes, milestone/action counts
    SUMMARY.md                # readable independently verified result
    benchmark.json            # resolved task definition
    game.zip                  # untouched starting map
    final.zip                 # final checkpoint, when saving succeeds
    telemetry.jsonl           # ticks, production/consumption, rates, research, rockets
    jobs.jsonl                # submitted/completed actions and partial failures
    activity.log              # readable runner + Codex activity
    codex.log                 # verbatim native Codex output
    agent.stdout.log
    agent.stderr.log
    agent-launch.json         # exact arguments used
    profile/                  # isolated game config, mods, saves, diagnostics
    workspace/                # frozen Python client, instructions, TASK, agent scripts
```

Production rates are sample deltas per game minute. Statistics include
handcrafting as well as machines. Starting inventory does not count toward
production milestones. Comparisons show milestone times in seconds and ticks,
and warn when benchmark, baseline-save, or Python-client hashes differ. The
result also records a hash of the harness sources. Native session IDs are retained when
Codex prints them. Any printed token usage remains in the raw log; no dollar-cost
estimate is inferred.

## Configuration

Optional `.env` settings (process environment takes precedence):

| Setting | Default / purpose |
| --- | --- |
| `FACTORIO_BIN` | Steam's `factorio.app/Contents/MacOS/factorio` under `~/Library/Application Support/Steam/steamapps/common/Factorio/` |
| `FACTORIO_DATA` | The app's `Contents/data` directory, derived from the executable |
| `AUTORIO_DATA_DIR` | `.autorio` in this repository |
| `AUTORIO_PORT` | `3000`; HTTP is bound to localhost |
| `RCON_PORT` | `27015`; RCON is bound to localhost |
| `RCON_PASSWORD` | Generated and retained in `.autorio/rcon-password` if omitted |
| `FACTORIO_WINDOW_SIZE` | `1000x760` |
| `FACTORIO_DISABLE_AUDIO` | Set to `1` for silent runs |
| `AUTORIO_STARTUP_SECONDS` | `180`; maximum graphical readiness wait |
| `AUTORIO_TERMINAL` | Set to `1` to use the optional Terminal viewer instead of web recording view |
| `CODEX_BIN` | `codex` on PATH, or this machine's bundled Codex CLI |
| `FACTORIO_API_BASE` | Python/CLI connection override; normally `http://127.0.0.1:3000` |
| `NODE_BIN` | Optional Node path for `./autorio` |

The installation directory and personal saves/configuration are not modified.
Graphical startup may take tens of seconds. A first-launch Steam/login dialog or
incompatible save/mod version can prevent readiness; inspect `factorio.log` and
the game window. Keep the manager in normal macOS execution context: a restricted
host sandbox can prevent Steam, graphics, process inspection, or loopback access.

The game bridge is a cooperative evaluation interface, not a security boundary
against a hostile agent. The manager retains raw RCON and management tools for
the operator. Run workspaces instruct agents to use only the Python gameplay API.
Walking and mining use the bundled **Autorio native character control** mod.
The Python API is unchanged: move/build/interact requests walk the actual
character along Factorio pathfinder routes, with normal collision and animation.
Mining uses native mining state, game mining times and speed bonuses. One mining
request per resource target extracts one cycle; a rock/tree/building is removed
only when its real mining cycle finishes. Results include actual item drops,
travel distance, game ticks and elapsed action time. Crafting queues work while
the agent plans and issues other actions.

The mod is installed only into managed profiles, alongside base Factorio; no
personal mods or installation files are changed. Map caches include the control
mod's content fingerprint. Existing saves can load the mod through normal mod
configuration changes; no benchmark IDs or benchmark versions were changed.

Unreachable targets return `no_path`/`blocked`. Cancellation, run cleanup and
pause handling stop native controls, and a five-second game-time heartbeat lease
stops abandoned actions if the manager disconnects. Saved controller requests are
never replayed after loading. Fluids that cannot be hand-mined are rejected.
Nearby building avoids unnecessary walking; rejected rotations, locked recipes
and rejected crafting requests report failure instead of false success.

## Development and APIs

```bash
npm run dev
npm test
```

`npm test` builds TypeScript, exercises run lifecycle/independent scoring with
fake game/agent processes, and runs the Python client tests. Actual graphical
integration requires the installed game and Steam. `npm run dev` restarts on edits,
which stops an active run; use a compiled manager for recordings.

Run endpoints:

- `GET /api/benchmarks`
- `POST /api/runs` with `{ "benchmark": "smoke", "model": "...", "agent": "codex" }`
- `GET /api/runs`, `GET /api/runs/:id`
- `GET /api/runs/:id/log?offset=0` (byte cursor)
- `POST /api/runs/:id/stop`

The JSON gameplay API remains schema version 2. Python is the supported agent
interface, available as both a library and command-line program. Import without
spawning a subprocess:

```python
from factorio import FactorioClient, action_job_ok, data_value

client = FactorioClient()
player = data_value(client.observe_player())["player"]
job = client.move([{"x": player["x"] + 1, "y": player["y"]}])
assert action_job_ok(job)
```

Actions wait for completion by default. Pass `detach=True` and optionally an
`idempotency_key` to use the job API asynchronously. Managed runs handle map
creation, game startup, final saving, and shutdown automatically. Manual game
lifecycle endpoints remain available through the Python client for diagnostics.

## Vanilla-compatible evaluation controls

`observe-map` exposes only chunks charted by the player's force:

```bash
python3 factorio.py observe-map --center-x 0 --center-y 0 --radius 96
```

The server uses only vanilla RCON commands, so unmodded clients can spectate.
Movement remains a time-accounted abstraction because vanilla RCON has no
persistent per-tick input hook; placement uses the real player cursor/build API.

## Coordinates

Build coordinates are explicit top-left tile anchors. For example:

```bash
python3 factorio.py act-build --entity boiler,-14,-50,4
```

Build and placement responses distinguish `requested_anchor`, `intended_center`,
`actual_center`, and `occupied_tiles`. Entity observations similarly distinguish
the queried tile from the entity center. Prototype observations report tile size
and whether an entity center aligns to integer or half-tile coordinates.

## Action jobs

All state-changing agent operations are serialized through jobs. The CLI creates
a job and polls it by default:

```bash
python3 factorio.py act-mine --target 10,12 --resource iron-ore
```

Use `--detach` to return the job immediately, then inspect or cancel it:

```bash
python3 factorio.py act-build --detach --idempotency-key build-smelters-1 \
  --entity stone-furnace,10,10,0
python3 factorio.py job-status --job-id <id>
python3 factorio.py job-cancel --job-id <id>
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

## Token accounting and science research

Runs capture input, cached-input, and output token counts. Completed Codex turns
supply final usage; when the runner stops Codex early, it recovers the latest
cumulative token counters from that run's local Codex session log. These are
labelled `last_reported`, not final: an interrupted request may not have reported
usage yet. Missing counts stay unavailable rather than becoming zero. The reader
only opens logs matching the run's session ID under `CODEX_HOME` (default
`~/.codex`); this is a CLI log-format fallback and may need updates with Codex
versions. Counts appear in `run.json`, `SUMMARY.md`, and the dashboard. Existing
runs with a session ID are backfilled when the manager starts if their logs exist.

Every new run tracks research completion for automation, logistic, military,
chemical, production, utility, and space science packs, independent of producing
those items. Milestones include wall seconds, game ticks, and observation time in
`run.json` and `milestones.jsonl`. Research already complete in the starting save
is marked `initial` at time zero. Detection uses the benchmark's telemetry sample
interval; timestamps are first observations, not exact engine event timestamps.

The Run Details production graph supports cumulative production or production per
game minute, and either active play time or game time on the x-axis. Select one
item, **All items combined** for a summed total, or **All items separately** for
individual colored lines. Combined production counts every item output, including
intermediate products; it excludes fluids and is not an inventory or net-production
measure.
Numbered science-research markers have matching labels below the graph. Download
telemetry to export its samples, baseline, token counters, and milestones as JSON.
This graph lives in the operator dashboard; recording view remains compact.

## Run names and thinking levels

Run names and directory IDs use Pacific local time (`America/Los_Angeles`), with
`PDT` or `PST` according to daylight saving time. For example,
`2026-10-16 13:02:39 PDT · smoke`; IDs use filesystem-safe separators and a short
random suffix. Internal timestamps remain UTC and sorting uses those timestamps.

The dashboard model dropdown offers GPT-6.1 Sol with Low thinking (default) or
Medium thinking. For other model/effort combinations, use the CLI:

```bash
./autorio start rocket --model gpt-6.1-sol --thinking high
```

Thinking defaults to `low` and is passed explicitly to Codex as
`model_reasoning_effort`. Supported levels depend on the selected model/client;
an unsupported combination is reported by Codex. Run metadata saves the separate
`model` and `reasoning_effort` fields, while the dashboard, comparisons, CLI, and
summary show a combined label such as `gpt-6.1-sol (high)`.

## Automatic OBS timelapses

OBS Studio 28+ includes WebSocket control; no OBS CLI or MCP plugin is required.
Enable **Tools → WebSocket Server Settings → Enable WebSocket server**, keep
**Enable Authentication** on, and allow OBS macOS Screen Recording access when
prompted. The manager reads the existing password from OBS's local configuration
without exposing it to the agent. `OBS_WEBSOCKET_URL` (localhost only) and
`OBS_WEBSOCKET_PASSWORD` can override connection settings.

Use the dashboard's **Record 6× timelapse with OBS** checkbox, or:

```bash
./autorio obs-status
./autorio start smoke --model gpt-6.1-sol --thinking low --video
```

`AUTORIO_OBS=1` enables recording by default; `--no-video` disables it for one run.
The local `.autorio/obs-settings.json` can also contain `{"enabled": true}`. Manual
(non-agent) tests do not record. Video capture opens the Codex log window even
with `--detach`, since that window is needed as a recording source. The optional
Terminal viewer requires `--no-video`.

The runner uses its own **Autorio Timelapse** profile and **Autorio Runs** scene.
It selects exactly one Factorio window and the current run's Codex log window
by its native window ID (the visible title is simply **Agent transcript**), then composes them at 1920×1080: game left two-thirds, log right
third. This does not move windows or capture the desktop. Capture runs at **5 fps**
and all audio inputs are muted for recording; previous profile, scene, and mute
states are restored afterwards. The runner refuses to take over an active OBS
recording, stream, virtual camera, or replay buffer.

Recording starts before agent timing, stops before the game closes, and is saved
under `.autorio/runs/<id>/video/`. The original MOV remains available. macOS
AVFoundation converts every captured frame into a silent **30 fps H.264 MP4**, so
playback is **6×** faster. No FFmpeg install is needed. Conversion runs in the
background after the benchmark, and its status/playback/download appear on Run
Details. `video/timelapse.json` records verified frame count, FPS, and duration.
Do not minimize either captured window while recording.

If OBS access, window selection, or startup fails, the run fails before launching
the paid agent. Recording/rendering errors are retained in the run's video status
and warnings. A hard manager crash can leave OBS recording; stop that recording
manually before another captured run. Existing unrelated OBS outputs are never
stopped automatically.

## Quota pauses and continuing a run

When Codex reports an exhausted account usage quota, the runner immediately
freezes the game, stops the agent, cancels pending actions, saves a checkpoint,
and stops Factorio and the current OBS recording. The run becomes **paused**.
Temporary request throttling/network errors and text printed by agent tools do
not count as account quota exhaustion.

Once your quota has reset, open the run from history and click **Resume run**, or:

```bash
./autorio resume RUN_ID
```

Resume is manual. The runner does not assume that the reset is five hours after
it detected the limit, and does not spend requests polling your quota. Resuming
before the quota resets will simply pause again when Codex reports the limit.
A paused run remains resumable after restarting the manager. Missing, changed,
or unsaved checkpoints are not silently replaced with the starting map.

The same run ID, fixed-map game, inventory/factory, agent workspace and Codex
session continue. Codex resumes its recorded session by ID when available; if the
limit occurred before a session ID was emitted, it starts a new conversation with
the saved workspace and an explicit game-state summary. Startup never resets a
resumed game's inventory, production baseline, or research milestones.

Elapsed time, the benchmark time limit, production graphs, research markers,
action counts and token usage accumulate across segments. Quota waiting and
Factorio startup/loading are excluded from active play time. Tokens recovered
from interrupted turns are still labeled as last reported, so an interrupted
request can leave a small accounting gap.

`run.json` records the checkpoint path, SHA-256, save time, quota error, and segment
boundaries. Each segment keeps its checkpoint in `segments/NNN/checkpoint.zip`.
The first recording remains in `video/`; later recordings live under
`segments/NNN/video/`. Run Details lists separate downloads for all finished
segments. Resume waits for the previous recording to finish rendering. If the
manager exits during conversion, it recovers a completed video on restart or marks
that conversion interrupted while retaining the original capture; this does not
block resuming a successfully saved game. Keep your
Codex session files and the run's workspace intact to retain conversation context.

This handles reported quota exhaustion with a clean shutdown; a power loss or
forced manager kill still appears as **interrupted**, rather than promising a
checkpoint that was never saved. Resuming requires the same Factorio version.
