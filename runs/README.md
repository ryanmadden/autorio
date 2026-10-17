# Agent run instructions

`run_template/AGENTS.md` supplies the agent instructions for managed benchmark
runs. The runner copies the Python client from the repository root and generates
`TASK.md` from the chosen benchmark. Run workspaces, saves, logs, and results live
under ignored `.autorio/runs/` and are created with `./autorio start` or the web UI.
