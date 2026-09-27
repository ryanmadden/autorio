# Runs

Each subdirectory under `runs/` is a standalone workspace for one Factorio
agent run.

To create a run:

```bash
cp -a runs/run_template runs/<run-name>
```

Then replace the placeholder in `TASK.md` and, if needed, customize
`AGENTS.md` for that run. The template includes a snapshot of the Python
client so each copied run can be used without importing files from the
repository root.

