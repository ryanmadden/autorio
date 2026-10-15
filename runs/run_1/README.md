# Factorio agent run

This directory is a lightweight workspace for one AI-agent playthrough.

## Files

- `TASK.md`: the objective for this run.
- `AGENTS.md`: operating instructions for the agent.
- `factorio.py`: dependency-free Python client and command-line interface.

The Factorio manager and game server are expected to be running separately.
The client connects to `http://localhost:3000` by default. Set
`FACTORIO_API_BASE` if the manager uses another address.

## Python usage

```bash
python3 factorio.py server-status
python3 factorio.py observe-player --limit-inventory 100 --limit-equipment 100
python3 factorio.py observe-world --window-x 0 --window-y 0 --radius 20 \
  --include terrain,entities
```

The client can also be imported by scripts:

```python
from factorio import FactorioClient, action_job_ok, data_value

client = FactorioClient()
player = data_value(client.observe_player())["player"]
job = client.move([{"x": player["x"] + 1, "y": player["y"]}])
assert action_job_ok(job)
```

Run `python3 factorio.py --help` or
`python3 factorio.py <command> --help` for the complete CLI surface.

