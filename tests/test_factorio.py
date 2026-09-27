import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import factorio


class ParsingTests(unittest.TestCase):
    def test_entities_and_targets_match_api_shapes(self):
        self.assertEqual(
            factorio.parse_entities(["stone-furnace,1,2,4"]),
            [{"name": "stone-furnace", "anchor": {"x": 1, "y": 2}, "direction": 4}],
        )
        self.assertEqual(
            factorio.parse_targets(["1.5,-2,iron-gear-wheel"], True),
            [{"x": 1.5, "y": -2, "recipe": "iron-gear-wheel"}],
        )

    def test_compact_removes_none_recursively(self):
        self.assertEqual(
            factorio.compact({"a": None, "b": [{"c": None, "d": 1}]}),
            {"b": [{"d": 1}]},
        )

    def test_explicit_help_succeeds(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = factorio.run(["server-status", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("server-status", stderr.getvalue())

    def test_cli_failure_is_json_and_nonzero(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = factorio.run(["unknown-command"])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(stdout.getvalue())["ok"])


class ClientTests(unittest.TestCase):
    def test_observation_route_and_none_compaction(self):
        client = factorio.FactorioClient("http://example.invalid/")
        with patch("factorio.http_request", return_value={"ok": True}) as request:
            response = client.observe_player(inventory_slots=3)
        self.assertEqual(response, {"ok": True})
        request.assert_called_once_with(
            "http://example.invalid",
            "POST",
            "/api/agent/observe/player",
            {"limits": {"inventory_slots": 3, "equipment_slots": None}},
        )

    def test_detached_action_returns_submission(self):
        client = factorio.FactorioClient()
        with patch.object(client, "request", return_value={"job_id": "abc", "status": "queued"}):
            job = client.craft("iron-gear-wheel", 2, detach=True, idempotency_key="key")
        self.assertEqual(job["job_id"], "abc")

    def test_save_management_routes(self):
        client = factorio.FactorioClient()
        with patch.object(client, "request", return_value={"ok": True}) as request:
            client.create_save("automation-test")
            client.save_active_game()
        self.assertEqual(
            request.call_args_list[0].args,
            ("POST", "/api/saves", {"name": "automation-test"}),
        )
        self.assertEqual(
            request.call_args_list[1].args,
            ("POST", "/api/server/save"),
        )

    def test_wait_for_job_reaches_terminal_state(self):
        client = factorio.FactorioClient(poll_interval=0)
        states = [
            {"job_id": "abc", "status": "running"},
            {"job_id": "abc", "status": "completed", "results": [{"ok": True}]},
        ]
        with patch.object(client, "job_status", side_effect=states):
            job = client.wait_for_job("abc")
        self.assertEqual(job["status"], "completed")
        self.assertTrue(factorio.action_job_ok(job))

    def test_action_job_rejects_raw_or_failed_results(self):
        self.assertFalse(factorio.action_job_ok({"status": "completed", "results": ["lua error"]}))
        self.assertFalse(factorio.action_job_ok({"status": "completed", "results": [{"ok": False}]}))


if __name__ == "__main__":
    unittest.main()
