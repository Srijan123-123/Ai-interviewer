const test = require("node:test");
const assert = require("node:assert/strict");
const timing = require("./interview-timing");

test("calculates remaining time from deadlines instead of interval counts", () => {
  const deadline = timing.deadlineAfter(10_000, 1_000);

  assert.equal(timing.remainingSeconds(deadline, 1_000), 10);
  assert.equal(timing.remainingSeconds(deadline, 1_001), 10);
  assert.equal(timing.remainingSeconds(deadline, 2_500), 9);
  assert.equal(timing.remainingSeconds(deadline, 10_999), 1);
  assert.equal(timing.remainingSeconds(deadline, 11_000), 0);
});

test("clamps expired deadlines and rejects invalid timer values", () => {
  assert.equal(timing.remainingMilliseconds(100, 101), 0);
  assert.throws(() => timing.deadlineAfter(-1, 0), RangeError);
  assert.throws(() => timing.remainingSeconds(Number.NaN, 0), RangeError);
});
