const test = require("node:test");
const assert = require("node:assert/strict");
const { InterviewError, InterviewService } = require("./interview");

const OWNER = "candidate@example.com";
const SUBMISSION_ID = "11111111-1111-4111-8111-111111111111";
const QUESTIONS = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  question: `How did you use React in the Live Badminton Scoring Platform? Question ${index + 1}.`,
  category: index < 2 ? "Project Architecture" : "Technologies and Tools",
  difficulty: index < 4 ? "Intermediate" : "Advanced",
  evidence_ids: ["PROJECT_001"]
}));

function createPracticeInterview(service = new InterviewService()) {
  return service.createInterview({
    questions: QUESTIONS,
    focus: "Technical interview practice",
    owner: OWNER
  });
}

function submitCurrentAnswer(service, interview, answer = "For example, I built a project with my team. The result improved our workflow, and I learned how to communicate clearly.") {
  const reservation = service.beginAnswerSubmission(
    interview.id,
    interview.questionId,
    SUBMISSION_ID,
    OWNER
  );
  return service.submitTranscribedAnswer(interview.id, answer, interview.questionId, reservation, OWNER);
}

test("creates a session that exposes only its current question", () => {
  const service = new InterviewService();
  const interview = createPracticeInterview(service);

  assert.equal(interview.questionNumber, 1);
  assert.equal(interview.totalQuestions, 10);
  assert.match(interview.currentQuestion, /React|Live Badminton Scoring Platform/i);
  assert.equal(interview.questionId, QUESTIONS[0].id);
  assert.equal(interview.complete, false);
  assert.equal("questions" in interview, false);
  assert.equal("answers" in interview, false);
});

test("does not allow skipping and exposes the next question only after submission", () => {
  const service = new InterviewService();
  const interview = createPracticeInterview(service);

  assert.throws(
    () => service.getNextQuestion(interview.id, OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 409
  );
  assert.throws(
    () => service.beginAnswerSubmission(interview.id, QUESTIONS[1].id, SUBMISSION_ID, OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 409
  );

  submitCurrentAnswer(service, interview);
  assert.throws(
    () => service.getCurrentQuestion(interview.id, OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 409
  );
  const next = service.getNextQuestion(interview.id, OWNER);
  assert.equal(next.questionNumber, 2);
  assert.equal(next.currentQuestion, QUESTIONS[1].question);
  assert.equal("questions" in next, false);
});

test("prevents concurrent and duplicate submissions for the same question", () => {
  const service = new InterviewService();
  const interview = createPracticeInterview(service);
  const reservation = service.beginAnswerSubmission(
    interview.id,
    interview.questionId,
    SUBMISSION_ID,
    OWNER
  );

  assert.throws(
    () => service.beginAnswerSubmission(interview.id, interview.questionId, SUBMISSION_ID, OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 409
  );
  service.submitTranscribedAnswer(
    interview.id,
    "A detailed answer with an example and a clear positive result from my work.",
    interview.questionId,
    reservation,
    OWNER
  );
  assert.throws(
    () => service.beginAnswerSubmission(
      interview.id,
      interview.questionId,
      "22222222-2222-4222-8222-222222222222",
      OWNER
    ),
    (error) => error instanceof InterviewError && error.statusCode === 409
  );
});

test("allows retry after transcription fails and a reservation is canceled", () => {
  const service = new InterviewService();
  const interview = createPracticeInterview(service);
  const firstAttempt = service.beginAnswerSubmission(
    interview.id,
    interview.questionId,
    SUBMISSION_ID,
    OWNER
  );
  service.cancelAnswerSubmission(interview.id, firstAttempt.token, OWNER);

  const retried = service.beginAnswerSubmission(
    interview.id,
    interview.questionId,
    SUBMISSION_ID,
    OWNER
  );
  const result = service.submitTranscribedAnswer(
    interview.id,
    "A detailed answer with an example and a clear positive result from my work.",
    interview.questionId,
    retried,
    OWNER
  );
  assert.equal(result.submitted, true);
  assert.equal(result.answered, 1);
});

test("rejects empty transcripts and preserves the question for retry", () => {
  const service = new InterviewService();
  const interview = createPracticeInterview(service);
  const reservation = service.beginAnswerSubmission(
    interview.id,
    interview.questionId,
    SUBMISSION_ID,
    OWNER
  );

  assert.throws(
    () => service.submitTranscribedAnswer(interview.id, " ", interview.questionId, reservation, OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 422
  );
  service.cancelAnswerSubmission(interview.id, reservation.token, OWNER);
  assert.equal(service.getCurrentQuestion(interview.id, OWNER).questionNumber, 1);
});

test("completes only after ten answers and returns a recap", () => {
  const service = new InterviewService();
  let interview = createPracticeInterview(service);

  assert.throws(
    () => service.completeInterview(interview.id, OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 409
  );
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    submitCurrentAnswer(service, interview);
    if (index < QUESTIONS.length - 1) {
      interview = service.getNextQuestion(interview.id, OWNER);
    }
  }

  assert.equal(service.getInterview(interview.id, OWNER).complete, true);
  const completed = service.completeInterview(interview.id, OWNER);
  assert.equal(completed.complete, true);
  assert.equal(completed.summary.answered, 10);
  assert.equal(completed.summary.averageScore, 4);
});

test("rejects invalid questions, unknown interviews, and another user's access", () => {
  const service = new InterviewService();
  const interview = createPracticeInterview(service);

  assert.throws(
    () => service.createInterview({ questions: QUESTIONS.slice(0, 9), focus: "Technical", owner: OWNER }),
    (error) => error instanceof InterviewError && error.statusCode === 400
  );
  assert.throws(
    () => service.getInterview("missing", OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 404
  );
  assert.throws(
    () => service.getCurrentQuestion(interview.id, "another@example.com"),
    (error) => error instanceof InterviewError && error.statusCode === 403
  );
});

test("expires temporary interview transcripts from in-memory sessions", () => {
  const service = new InterviewService();
  const interview = createPracticeInterview(service);
  service.sessions.get(interview.id).expiresAt = Date.now() - 1;

  assert.throws(
    () => service.getInterview(interview.id, OWNER),
    (error) => error instanceof InterviewError && error.statusCode === 404
  );
  assert.equal(service.sessions.has(interview.id), false);
});
