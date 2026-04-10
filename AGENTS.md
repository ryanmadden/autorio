# AGENTS.md

## Project summary
- Node/TypeScript service that manages a local Factorio headless server and exposes a JSON API plus a small web UI.
- Includes a CLI (`factorio`) that talks to the API and supports observe/act commands via RCON.

## Key paths
- `src/server.ts`: HTTP API + Factorio process management + RCON bridge.
- `src/agent-cli.ts`: CLI for calling the API.
- `public/index.html`, `public/app.js`: Web UI for status, logs, RCON, and world view.
- `factorio/`: Expected Factorio install root (binary at `factorio/bin/x64/factorio`, saves at `factorio/saves`).
- `dist/`: Build output (`dist/server.js`, `dist/agent-cli.js`).
- `RUN_REPORT.md`: Known issues / proposed improvements from an AI playthrough.

## Common commands
- `npm run dev`: Run the server in watch mode (tsx).
- `npm run build`: Compile TypeScript to `dist/`.
- `npm run start`: Run compiled server (`dist/server.js`).
- `npm run agent`: Run compiled CLI (`dist/agent-cli.js`).

## Environment/config
- `.env` is loaded if present. Supported:
  - `RCON_HOST` (default `127.0.0.1`)
  - `RCON_PORT` (number)
  - `RCON_PASSWORD`
- CLI uses `FACTORIO_API_BASE` (default `http://localhost:3000`).

## API + CLI surface (high level)
- Server endpoints include:
  - `GET /api/server/status`, `POST /api/server/start`, `POST /api/server/stop`
  - `GET /api/saves`, `GET /api/server/logs`, `POST /api/rcon/command`
  - Agent endpoints under `/api/agent/...` for observe/actions (world, player, research, recipes, build, mine, rotate, set-recipe, craft, insert, extract, resources, entity-prototype).
- CLI mirrors these as commands like `server-status`, `observe-world`, `act-build`, etc. See `src/agent-cli.ts` for full usage text.

## Notes and known gaps
- `RUN_REPORT.md` documents behavior gaps and desired enhancements (crafting queue visibility, richer entity inspection, placement diagnostics, coordinate normalization, etc.).

## Local assumptions
- The server expects a working Factorio headless install in `factorio/` and at least one save ZIP in `factorio/saves/` before `server-start`.
