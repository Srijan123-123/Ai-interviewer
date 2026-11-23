const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./server");

const OWNER = "candidate@example.com";
const OTHER_OWNER = "other@example.com";
const TOKEN = "c".repeat(64);
const OTHER_TOKEN = "e".repeat(64);
const TEST_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2cAAAAASUVORK5CYII=";

async function setupServer(t) {
  const authService = {
    getUser: (token) => token === TOKEN
      ? { email: OWNER }
      : token === OTHER_TOKEN
        ? { email: OTHER_OWNER }
        : null,
    logout: () => {}
  };
  const { server } = createServer({ authService });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("accepts and stores verification consent and image data", async (t) => {
  const baseUrl = await setupServer(t);
  const consent = await fetch(`${baseUrl}/api/proctoring/consent`, {
    method: "POST",
    headers: { Cookie: `clearview_session=${TOKEN}` },
    body: JSON.stringify({ consent: true, policyVersion: "2026-01" })
  });
  const consentPayload = await consent.json();
  assert.equal(consent.status, 200);
  assert.equal(consentPayload.consented, true);
  assert.equal(consentPayload.policyVersion, "2026-01");

  const verification = await fetch(`${baseUrl}/api/proctoring/verification`, {
    method: "POST",
    headers: { Cookie: `clearview_session=${TOKEN}` },
    body: JSON.stringify({ imageDataUrl: TEST_PNG })
  });
  const verificationPayload = await verification.json();
  assert.equal(verification.status, 201);
  assert.equal(verificationPayload.verified, true);

  const microphone = await fetch(`${baseUrl}/api/proctoring/microphone-verification`, {
    method: "POST",
    headers: { Cookie: `clearview_session=${TOKEN}` },
    body: JSON.stringify({ verified: true })
  });
  const microphonePayload = await microphone.json();
  assert.equal(microphone.status, 200);
  assert.equal(microphonePayload.microphoneVerified, true);

  const status = await fetch(`${baseUrl}/api/proctoring/session`, {
    headers: { Cookie: `clearview_session=${TOKEN}` }
  });
  const statusPayload = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusPayload.verified, true);
  assert.equal(statusPayload.microphoneVerified, true);
  assert.equal(statusPayload.consented, true);
});

test("requires consent, a verified photo, and microphone confirmation in order", async (t) => {
  const baseUrl = await setupServer(t);
  const headers = { Cookie: `clearview_session=${TOKEN}` };

  const prematureMic = await fetch(`${baseUrl}/api/proctoring/microphone-verification`, {
    method: "POST",
    headers,
    body: JSON.stringify({ verified: true })
  });
  assert.equal(prematureMic.status, 409);

  const photoWithoutConsent = await fetch(`${baseUrl}/api/proctoring/verification`, {
    method: "POST",
    headers,
    body: JSON.stringify({ imageDataUrl: TEST_PNG })
  });
  assert.equal(photoWithoutConsent.status, 400);

  await fetch(`${baseUrl}/api/proctoring/consent`, {
    method: "POST",
    headers,
    body: JSON.stringify({ consent: true })
  });
  await fetch(`${baseUrl}/api/proctoring/verification`, {
    method: "POST",
    headers,
    body: JSON.stringify({ imageDataUrl: TEST_PNG })
  });

  const resumeWithoutMic = await fetch(`${baseUrl}/api/resume/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify({})
  });
  assert.equal(resumeWithoutMic.status, 403);

  const generateQuestionsWithoutMic = await fetch(`${baseUrl}/api/interviews/generate-questions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ analysisId: "00000000-0000-4000-8000-000000000001" })
  });
  assert.equal(generateQuestionsWithoutMic.status, 403);

  const startInterviewWithoutMic = await fetch(`${baseUrl}/api/interviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ analysisId: "00000000-0000-4000-8000-000000000001" })
  });
  assert.equal(startInterviewWithoutMic.status, 403);

  const invalidMimeBytes = Buffer.from("this is not an image").toString("base64");
  const invalidImage = await fetch(`${baseUrl}/api/proctoring/verification`, {
    method: "POST",
    headers,
    body: JSON.stringify({ imageDataUrl: `data:image/jpeg;base64,${invalidMimeBytes}` })
  });
  assert.equal(invalidImage.status, 400);
});

test("accepts multipart photo retries after an invalid image upload", async (t) => {
  const baseUrl = await setupServer(t);
  const headers = { Cookie: `clearview_session=${TOKEN}` };
  await fetch(`${baseUrl}/api/proctoring/consent`, {
    method: "POST",
    headers,
    body: JSON.stringify({ consent: true })
  });

  const invalidForm = new FormData();
  invalidForm.append("image", new Blob(["not an image"], { type: "image/png" }), "verification.png");
  const rejected = await fetch(`${baseUrl}/api/proctoring/verification`, {
    method: "POST",
    headers,
    body: invalidForm
  });
  assert.equal(rejected.status, 400);

  const validForm = new FormData();
  validForm.append(
    "image",
    new Blob([Buffer.from(TEST_PNG.split(",")[1], "base64")], { type: "image/png" }),
    "verification.png"
  );
  const retried = await fetch(`${baseUrl}/api/proctoring/verification`, {
    method: "POST",
    headers,
    body: validForm
  });
  assert.equal(retried.status, 201);
  assert.equal((await retried.json()).verified, true);
});

test("records proctoring events and enforces user ownership", async (t) => {
  const baseUrl = await setupServer(t);
  const eventResponse = await fetch(`${baseUrl}/api/proctoring/events`, {
    method: "POST",
    headers: { Cookie: `clearview_session=${TOKEN}` },
    body: JSON.stringify({ type: "camera_warning", details: { source: "browser" } })
  });
  const eventPayload = await eventResponse.json();
  assert.equal(eventResponse.status, 201);
  assert.equal(eventPayload.type, "camera_warning");

  const otherUser = await fetch(`${baseUrl}/api/proctoring/session`, {
    headers: { Cookie: `clearview_session=${OTHER_TOKEN}` }
  });
  assert.equal(otherUser.status, 200);
  const otherStatus = await otherUser.json();
  assert.equal(otherStatus.consented, false);
  assert.equal(otherStatus.verified, false);
  assert.equal(otherStatus.microphoneVerified, false);
});
