"""Iceberg Kalshi sports tape helpers — no live CLOB, no lake writes."""

from __future__ import annotations

import unittest

from lobster_nb.parlay import self_check
from lobster_nb.parlay_backtest import tape_self_check


class TapeHelpersTest(unittest.TestCase):
    def test_parlay_port_fixtures(self) -> None:
        self.assertEqual(self_check(), [])

    def test_lake_tape_helpers(self) -> None:
        self.assertEqual(tape_self_check(), [])


if __name__ == "__main__":
    unittest.main()
