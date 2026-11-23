const { randomUUID } = require("node:crypto");
const PROCTORING_TTL_MS = 24 * 60 * 60 * 1000;

class ProctoringError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ProctoringError";
    this.statusCode = statusCode;
  }
}

class ProctoringService {
  constructor() {
    this.sessions = new Map();
    this.maxEventsPerSession = 200;
  }

  ensureProfile(email) {
    if (typeof email !== "string" || !email.trim()) {
      throw new ProctoringError("Sign in to continue verification.", 401);
    }
    const normalizedEmail = email.trim().toLowerCase();
    this.removeExpiredProfiles();
    if (!this.sessions.has(normalizedEmail)) {
      this.sessions.set(normalizedEmail, {
        email: normalizedEmail,
        consented: false,
        consentedAt: null,
        policyVersion: null,
        verification: null,
        verificationCapturedAt: null,
        microphoneVerified: false,
        microphoneVerifiedAt: null,
        events: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + PROCTORING_TTL_MS
      });
    }
    const profile = this.sessions.get(normalizedEmail);
    profile.expiresAt = Date.now() + PROCTORING_TTL_MS;
    return profile;
  }

  removeExpiredProfiles() {
    const now = Date.now();
    for (const [email, profile] of this.sessions) {
      if (profile.expiresAt <= now) {
        this.sessions.delete(email);
      }
    }
  }

  saveConsent(email, consent, policyVersion = "2026-01") {
    const profile = this.ensureProfile(email);
    if (consent !== true) {
      throw new ProctoringError("You must explicitly consent before the camera can be used.", 400);
    }
    profile.consented = true;
    profile.consentedAt = Date.now();
    profile.policyVersion = typeof policyVersion === "string" && policyVersion.trim()
      ? policyVersion.trim()
      : "2026-01";
    return {
      consented: true,
      policyVersion: profile.policyVersion,
      consentedAt: profile.consentedAt
    };
  }

  normalizeImageDataUrl(imageDataUrl) {
    if (typeof imageDataUrl !== "string" || !imageDataUrl.trim()) {
      throw new ProctoringError("A candidate verification photo is required.", 400);
    }
    const match = imageDataUrl.trim().match(/^data:(image\/(png|jpeg|jpg|webp));base64,([\s\S]+)$/i);
    if (!match) {
      throw new ProctoringError("Verification photos must be uploaded as a PNG, JPEG, or WebP image.", 400);
    }
    const mimeType = match[1].toLowerCase();
    const encoded = match[3];
    if (!encoded || encoded.length < 32) {
      throw new ProctoringError("The verification photo is incomplete.", 400);
    }
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
      throw new ProctoringError("The verification photo must be smaller than 5 MB.", 413);
    }
    const hasValidSignature =
      (mimeType === "image/png" && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      ((mimeType === "image/jpeg" || mimeType === "image/jpg") && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) ||
      (mimeType === "image/webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP");
    if (!hasValidSignature) {
      throw new ProctoringError("The uploaded file does not match its declared image type.", 400);
    }
    return { mimeType, buffer };
  }

  saveVerification(email, imageDataUrl) {
    const profile = this.ensureProfile(email);
    if (!profile.consented) {
      throw new ProctoringError("Please provide your consent before verifying your identity.", 400);
    }
    const { mimeType, buffer } = this.normalizeImageDataUrl(imageDataUrl);
    profile.verification = {
      id: randomUUID(),
      mimeType,
      size: buffer.length,
      capturedAt: Date.now(),
      imageDataUrl
    };
    profile.verificationCapturedAt = profile.verification.capturedAt;
    return {
      verified: true,
      verificationId: profile.verification.id,
      mimeType: profile.verification.mimeType,
      size: profile.verification.size,
      capturedAt: profile.verification.capturedAt
    };
  }

  verifyMicrophone(email, verified) {
    const profile = this.ensureProfile(email);
    if (!profile.consented || !profile.verification) {
      throw new ProctoringError("Complete camera verification before confirming the microphone.", 409);
    }
    if (verified !== true) {
      throw new ProctoringError("Complete the microphone test before continuing.", 400);
    }
    profile.microphoneVerified = true;
    profile.microphoneVerifiedAt = Date.now();
    return {
      microphoneVerified: true,
      microphoneVerifiedAt: profile.microphoneVerifiedAt
    };
  }

  assertInterviewReady(email) {
    const profile = this.ensureProfile(email);
    if (!profile.consented || !profile.verification || !profile.microphoneVerified) {
      throw new ProctoringError("Complete camera and microphone verification before continuing.", 403);
    }
    return true;
  }

  recordEvent(email, eventType, details = {}) {
    const profile = this.ensureProfile(email);
    const payload = {
      id: randomUUID(),
      type: typeof eventType === "string" && eventType.trim() ? eventType.trim() : "unknown_event",
      timestamp: Date.now(),
      details: details && typeof details === "object" && !Array.isArray(details) ? details : {}
    };
    profile.events.push(payload);
    if (profile.events.length > this.maxEventsPerSession) {
      profile.events.splice(0, profile.events.length - this.maxEventsPerSession);
    }
    return payload;
  }

  getSessionStatus(email) {
    const profile = this.ensureProfile(email);
    return {
      email: profile.email,
      consented: profile.consented,
      consentedAt: profile.consentedAt,
      policyVersion: profile.policyVersion,
      verified: Boolean(profile.verification),
      verificationCapturedAt: profile.verificationCapturedAt,
      microphoneVerified: profile.microphoneVerified,
      microphoneVerifiedAt: profile.microphoneVerifiedAt,
      status: profile.microphoneVerified
        ? "ready"
        : profile.verification
          ? "camera_verified"
          : profile.consented
            ? "consented"
            : "pending",
      eventCount: profile.events.length,
      warnings: profile.events.filter((event) => event.type.startsWith("warning_") || event.type.includes("warning")).length
    };
  }
}

module.exports = { ProctoringError, ProctoringService };
