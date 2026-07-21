import assert from "node:assert/strict";
import test from "node:test";
import { isSnapshotPoll, pollingKey } from "../src/polling.js";

test("recognizes snapshots but leaves blocking waits alone", () => {
  assert.equal(isSnapshotPoll("hub", { op: "jobs" }), true);
  assert.equal(isSnapshotPoll("hub", { op: "wait" }), false);
  assert.equal(isSnapshotPoll("job", { op: "status" }), true);
  assert.equal(isSnapshotPoll("bash", { command: "jobs" }), false);
});

test("normalizes polling identities", () => {
  assert.equal(
    pollingKey("hub", { op: "jobs", ids: ["b", "a"] }),
    pollingKey("hub", { op: "jobs", ids: ["a", "b"] }),
  );
});
