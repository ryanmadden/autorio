# AGENTS.md

## Background

In this environment, the game Factorio will be used as an evaluation of your capabilities.

## Objective

Read `TASK.md` and complete the objective in the running Factorio game as quickly as you can. Do not stop until the objective is complete. You will be evaluated on how quickly you complete the objective.

## Available interface

- Use `factorio.py` to observe and act in the game.
- It is both a command-line program and an importable Python module.
- The default manager address is `http://localhost:3000`.
- If provided, `FACTORIO_API_BASE` overrides the manager address.
- Use `python3 factorio.py --help` and command-specific help when needed.

## Operating rules

- You may only interact with the game through the provided Python library. Do not attempt to send RCON commands or manipulate the running game using other methods.
- Inspect the current player, inventory, world, resources, and relevant entity
  prototypes before committing to a substantial build.
- Prefer importing `FactorioClient` in a Python script for multi-step plans.
- Treat action results as authoritative. Check `action_job_ok()` and inspect
  individual results because a completed batch may contain partial failures.
- Use placement observations before constructing tightly packed layouts.
- Account for the player's simulated walking path and entity reach. If a valid
  placement reports `blocked`, move to an accessible side and retry only the
  failed placement.
- Verify the completed result by observing entity status and inventories over
  time. Successful placement alone does not prove that a factory works.
- Do not edit the manager bridge or restart, stop, or replace the running game
  server unless `TASK.md` explicitly asks for it.
- Do not modify `factorio.py` merely to bypass an in-game challenge.

## Completion

When the objective is working, provide a concise report of what was built or
changed, how it was verified, and any limitations that remain.
