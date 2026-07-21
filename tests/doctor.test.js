import assert from "node:assert/strict";
import test from "node:test";
import { checkOmpCompatibility, parseVersion } from "../src/doctor.js";

test("parses installed OMP output", () => {
  assert.deepEqual(parseVersion("omp v17.0.6"), { major: 17, minor: 0, patch: 6 });
  assert.deepEqual(parseVersion("omp/17.0.6"), { major: 17, minor: 0, patch: 6 });
});

test("accepts only the verified OMP major by default", () => {
  assert.equal(checkOmpCompatibility("omp v17.0.6").severity, "ok");
  assert.equal(checkOmpCompatibility("omp v16.9.0").compatible, false);
  assert.equal(checkOmpCompatibility("omp v18.0.0").compatible, false);
  assert.equal(checkOmpCompatibility("omp v18.0.0").severity, "error");
  assert.equal(checkOmpCompatibility("omp v18.0.0", { allowFutureMajor: true }).severity, "warning");
});
