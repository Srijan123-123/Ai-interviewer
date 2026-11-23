(function exposeInterviewTiming(global) {
  const timing = Object.freeze({
    deadlineAfter(durationMs, now = Date.now()) {
      if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(now)) {
        throw new RangeError("Timer duration and current time must be finite non-negative values.");
      }
      return now + durationMs;
    },
    remainingMilliseconds(deadline, now = Date.now()) {
      if (!Number.isFinite(deadline) || !Number.isFinite(now)) {
        throw new RangeError("Timer deadline and current time must be finite values.");
      }
      return Math.max(0, deadline - now);
    },
    remainingSeconds(deadline, now = Date.now()) {
      if (!Number.isFinite(deadline) || !Number.isFinite(now)) {
        throw new RangeError("Timer deadline and current time must be finite values.");
      }
      return Math.ceil(Math.max(0, deadline - now) / 1000);
    }
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = timing;
  }
  if (global) {
    global.InterviewTiming = timing;
  }
})(typeof window === "undefined" ? null : window);
