const test = require("node:test");
const assert = require("node:assert/strict");
const { InterviewService } = require("./interview");
const { createServer } = require("./server");

const OWNER = "candidate@example.com";
const OTHER_OWNER = "other@example.com";
const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const QUESTIONS = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  question: `How would you approach technical scenario number ${index + 1}?`,
  category: "Core Technical Concepts",
  difficulty: "Intermediate",
  evidence_ids: ["SKILL_001"]
}));

async function setupServer(
  t,
  userForToken = new Map([[TOKEN, OWNER], [OTHER_TOKEN, OTHER_OWNER]]),
  transcribeAudio
) {
  const interviewService = new InterviewService();
  const authService = {
    getUser: (token) => userForToken.has(token) ? { email: userForToken.get(token) } : null,
    logout: () => {}
  };
  const aiService = {
    transcribeAudio: transcribeAudio || (async (bytes, mimeType) => {
      assert.equal(bytes.length, 7);
      assert.equal(mimeType, "audio/webm");
      return "I used an example to explain my technical decision and the result.";
    })
  };
  const { server } = createServer({
    authService,
    interviewService,
    aiService,
    resumeAnalysisService: {}
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const interview = interviewService.createInterview({
    questions: QUESTIONS,
    focus: "Technical interview practice",
    owner: OWNER
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    interview,
    interviewService
  };
}

function authHeaders(token = TOKEN) {
  return { Cookie: `clearview_session=${token}` };
}

function audioForm(
  questionId,
  type = "audio/webm",
  submissionId = "22222222-2222-4222-8222-222222222222"
) {
  const form = new FormData();
  form.append("questionId", String(questionId));
  form.append("submissionId", submissionId);
  form.append("audio", new Blob([Buffer.from("1234567")], { type }), "answer.webm");
  return form;
}

test("initializes the AI service before injecting it into resume analysis", () => {
  const aiService = { analyzeResume() {}, generateQuestions() {}, transcribeAudio() {} };
  const resumeAnalysisService = {};
  const authService = {};
  const interviewService = {};
  const { services } = createServer({
    aiService,
    authService,
    interviewService,
    resumeAnalysisService
  });

  assert.equal(services.aiService, aiService);
  assert.equal(services.authService, authService);
  assert.equal(services.interviewService, interviewService);
  assert.equal(services.resumeAnalysisService, resumeAnalysisService);
});

test("shares one default AI service with resume analysis per server instance", () => {
  const first = createServer();
  const second = createServer();

  assert.equal(first.services.aiService, first.services.resumeAnalysisService.aiService);
  assert.equal(second.services.aiService, second.services.resumeAnalysisService.aiService);
  assert.notEqual(first.services.aiService, second.services.aiService);
  assert.notEqual(first.services.resumeAnalysisService, second.services.resumeAnalysisService);
});

test("authenticated audio submission transcribes, stores, and advances sequentially", async (t) => {
  const { baseUrl, interview, interviewService } = await setupServer(t);
  const currentResponse = await fetch(
    `${baseUrl}/api/interviews/${interview.id}/current-question`,
    { headers: authHeaders() }
  );
  const current = await currentResponse.json();
  assert.equal(currentResponse.status, 200);
  assert.equal(current.questionNumber, 1);
  assert.equal(current.currentQuestion, QUESTIONS[0].question);
  assert.equal("questions" in current, false);

  const skipped = await fetch(
    `${baseUrl}/api/interviews/${interview.id}/next-question`,
    { headers: authHeaders() }
  );
  assert.equal(skipped.status, 409);

  const submittedResponse = await fetch(`${baseUrl}/api/interviews/${interview.id}/answers`, {
    method: "POST",
    headers: authHeaders(),
    body: audioForm(current.questionId)
  });
  const submitted = await submittedResponse.json();
  assert.equal(submittedResponse.status, 200);
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.answered, 1);
  assert.equal("transcript" in submitted, false);
  assert.equal("currentQuestion" in submitted, false);
  assert.equal(interviewService.sessions.get(interview.id).answers[0].response,
    "I used an example to explain my technical decision and the result.");

  const nextResponse = await fetch(
    `${baseUrl}/api/interviews/${interview.id}/next-question`,
    { headers: authHeaders() }
  );
  const next = await nextResponse.json();
  assert.equal(next.questionNumber, 2);
  assert.equal(next.currentQuestion, QUESTIONS[1].question);

  const duplicate = await fetch(`${baseUrl}/api/interviews/${interview.id}/answers`, {
    method: "POST",
    headers: authHeaders(),
    body: audioForm(current.questionId)
  });
  const duplicateResult = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateResult.duplicate, true);
  assert.equal(duplicateResult.answered, 1);
});

test("protects audio endpoints with authentication and interview ownership", async (t) => {
  const { baseUrl, interview } = await setupServer(t);
  const unauthenticated = await fetch(
    `${baseUrl}/api/interviews/${interview.id}/current-question`
  );
  assert.equal(unauthenticated.status, 401);

  const otherAccount = await fetch(
    `${baseUrl}/api/interviews/${interview.id}/current-question`,
    { headers: authHeaders(OTHER_TOKEN) }
  );
  assert.equal(otherAccount.status, 403);
});

test("rejects non-audio uploads and malformed answer requests", async (t) => {
  const { baseUrl, interview } = await setupServer(t);
  const invalidMime = await fetch(`${baseUrl}/api/interviews/${interview.id}/answers`, {
    method: "POST",
    headers: authHeaders(),
    body: audioForm(interview.questionId, "text/plain")
  });
  assert.equal(invalidMime.status, 400);

  const jsonAnswer = await fetch(`${baseUrl}/api/interviews/${interview.id}/answers`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "This old text path must not be accepted." })
  });
  assert.equal(jsonAnswer.status, 415);
});

test("releases the answer lock when transcription fails so the candidate can retry", async (t) => {
  let transcriptionAttempt = 0;
  const { baseUrl, interview, interviewService } = await setupServer(
    t,
    undefined,
    async () => {
      transcriptionAttempt += 1;
      if (transcriptionAttempt === 1) {
        const { AiServiceError } = require("./ai");
        throw new AiServiceError("Transcription provider is unavailable.", 502, "transcription_provider_unavailable");
      }
      return "I used an example and explained the result of the technical work.";
    }
  );

  const failed = await fetch(`${baseUrl}/api/interviews/${interview.id}/answers`, {
    method: "POST",
    headers: authHeaders(),
    body: audioForm(interview.questionId)
  });
  assert.equal(failed.status, 502);
  assert.equal(interviewService.sessions.get(interview.id).answers.length, 0);

  const retried = await fetch(`${baseUrl}/api/interviews/${interview.id}/answers`, {
    method: "POST",
    headers: authHeaders(),
    body: audioForm(interview.questionId)
  });
  assert.equal(retried.status, 200);
  assert.equal(interviewService.sessions.get(interview.id).answers.length, 1);
});

test("only completes the API interview after all ten audio answers", async (t) => {
  const { baseUrl, interview } = await setupServer(t);
  let current = interview;
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    const response = await fetch(`${baseUrl}/api/interviews/${interview.id}/answers`, {
      method: "POST",
      headers: authHeaders(),
      body: audioForm(current.questionId)
    });
    assert.equal(response.status, 200);
    if (index < QUESTIONS.length - 1) {
      const nextResponse = await fetch(
        `${baseUrl}/api/interviews/${interview.id}/next-question`,
        { headers: authHeaders() }
      );
      current = await nextResponse.json();
      assert.equal(current.questionNumber, index + 2);
    }
  }

  const completedResponse = await fetch(`${baseUrl}/api/interviews/${interview.id}/complete`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const completed = await completedResponse.json();
  assert.equal(completedResponse.status, 200);
  assert.equal(completed.complete, true);
  assert.equal(completed.summary.answered, 10);
  assert.equal("questions" in completed, false);
});
