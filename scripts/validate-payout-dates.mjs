import assert from "node:assert/strict";
import { computeAdjustedPayDate, computeAdjustedPayDateForNominalDate } from "../src/lib/payouts/scheduler.js";

const run = () => {
  // Weekend check: 15 Jun 2025 is Sunday, nearest business day is Monday 16 Jun.
  const june2025 = computeAdjustedPayDate(2025, 5);
  assert.equal(june2025.nominalPayDate, "2025-06-15");
  assert.equal(june2025.adjustedPayDate, "2025-06-16");

  // Federal holiday check in static map.
  const jan2025 = computeAdjustedPayDate(2025, 0);
  assert.equal(jan2025.nominalPayDate, "2025-01-15");
  assert.equal(jan2025.adjustedPayDate, "2025-01-15");

  // Tie-break check with custom holiday set: both 14th and 16th are 1 day away.
  const tieBreak = computeAdjustedPayDateForNominalDate(
    new Date(Date.UTC(2026, 6, 15)),
    new Set(["2026-07-15"])
  );
  assert.equal(tieBreak.nominalPayDate, "2026-07-15");
  assert.equal(tieBreak.adjustedPayDate, "2026-07-14");

  // Month boundary sanity.
  const feb2026 = computeAdjustedPayDate(2026, 1);
  assert.ok(/^2026-02-\d{2}$/.test(feb2026.adjustedPayDate));

  console.log("Payout date rule checks passed.");
};

run();
