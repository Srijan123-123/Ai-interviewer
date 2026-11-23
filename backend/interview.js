const { randomUUID } = require("node:crypto");
const INTERVIEW_TTL_MS = 2 * 60 * 60 * 1000;

class InterviewError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "InterviewError";
    this.statusCode = statusCode;
  }
}

class InterviewService {
  constructor() {
    this.sessions = new Map();
  }

  createInterview({ questions, focus, owner }) {
    this.removeExpiredSessions();
    if (
      !Array.isArray(questions) ||
      questions.length !== 10 ||
      questions.some((question) =>
        !question ||
        (typeof question.id !== "string" && !Number.isInteger(question.id)) ||
        typeof question.question !== "string" ||
        !question.question.trim()
      ) ||
      new Set(questions.map((question) => String(question.id))).size !== 10
    ) {
      throw new InterviewError("Generate exactly 10 valid questions before starting the interview.");
    }
    if (typeof focus !== "string" || !focus.trim() || typeof owner !== "string" || !owner) {
      throw new InterviewError("Interview details are invalid.");
    }

    const interview = {
      id: randomUUID(),
      owner,
      focus: focus.trim().slice(0, 100),
      questions,
      questionIndex: 0,
      servedQuestionIndex: 0,
      processingToken: null,
      answers: [],
      complete: false,
      expiresAt: Date.now() + INTERVIEW_TTL_MS
    };

    this.sessions.set(interview.id, interview);
    return this.getInterview(interview.id, owner);
  }

  getInterview(id, owner) {
    const interview = this.getSession(id, owner);

    return this.toPublicInterview(interview);
  }

  getCurrentQuestion(id, owner) {
    const interview = this.getSession(id, owner);
    if (interview.complete) {
      return this.toPublicInterview(interview);
    }
    if (interview.servedQuestionIndex !== interview.questionIndex) {
      throw new InterviewError("Submit your current answer before requesting the next question.", 409);
    }
    return this.toPublicInterview(interview);
  }

  getNextQuestion(id, owner) {
    const interview = this.getSession(id, owner);
    if (interview.complete) {
      throw new InterviewError("This interview is already complete.", 409);
    }
    if (interview.answers.length !== interview.questionIndex || interview.questionIndex === 0) {
      throw new InterviewError("Submit your current answer before requesting the next question.", 409);
    }
    if (interview.processingToken) {
      throw new InterviewError("Your answer is still being processed.", 409);
    }
    interview.servedQuestionIndex = interview.questionIndex;
    return this.toPublicInterview(interview);
  }

  beginAnswerSubmission(id, questionId, submissionId, owner) {
    const interview = this.getSession(id, owner);
    if (typeof submissionId !== "string" || !/^[0-9a-f-]{36}$/iu.test(submissionId)) {
      throw new InterviewError("The audio submission is missing a valid request ID.", 400);
    }
    const previousAnswer = interview.answers.find(
      (answer) => String(answer.questionId) === String(questionId)
    );
    if (previousAnswer && previousAnswer.submissionId === submissionId) {
      return {
        alreadySubmitted: true,
        result: {
          submitted: true,
          duplicate: true,
          answered: interview.answers.length,
          totalQuestions: interview.questions.length,
          complete: interview.complete,
          feedback: this.createFeedback(previousAnswer.response, previousAnswer.score),
          summary: interview.complete ? this.createSummary(interview) : null
        }
      };
    }
    if (previousAnswer) {
      throw new InterviewError("An answer for this question has already been submitted.", 409);
    }
    if (interview.complete) {
      throw new InterviewError("This interview is already complete.", 409);
    }
    if (interview.servedQuestionIndex !== interview.questionIndex) {
      throw new InterviewError("The current question has not been issued.", 409);
    }
    const currentQuestion = interview.questions[interview.questionIndex];
    if (!currentQuestion || String(currentQuestion.id) !== String(questionId)) {
      throw new InterviewError("The submitted answer does not match the current question.", 409);
    }
    if (interview.processingToken) {
      throw new InterviewError("An answer for this question is already being processed.", 409);
    }
    const token = randomUUID();
    interview.processingToken = token;
    return { token, submissionId };
  }

  cancelAnswerSubmission(id, token, owner) {
    const interview = this.sessions.get(id);
    if (interview && interview.owner === owner && interview.processingToken === token) {
      interview.processingToken = null;
    }
  }

  submitTranscribedAnswer(id, answer, questionId, reservation, owner) {
    const interview = this.getSession(id, owner);
    if (
      !reservation ||
      interview.processingToken !== reservation.token ||
      interview.complete
    ) {
      throw new InterviewError("This answer submission is no longer active.", 409);
    }
    if (
      typeof answer !== "string" ||
      !answer.trim() ||
      answer.trim().length > 12_000 ||
      String(interview.questions[interview.questionIndex].id) !== String(questionId)
    ) {
      throw new InterviewError("The audio recording did not produce a valid transcript. Please record and submit again.", 422);
    }

    const response = answer.trim();
    const score = this.scoreAnswer(response);
    interview.answers.push({
      questionId: interview.questions[interview.questionIndex].id,
      submissionId: reservation.submissionId,
      question: interview.questions[interview.questionIndex].question,
      response,
      score
    });
    interview.questionIndex += 1;
    interview.servedQuestionIndex = null;
    interview.processingToken = null;
    interview.complete = interview.questionIndex >= interview.questions.length;
    interview.expiresAt = Date.now() + INTERVIEW_TTL_MS;

    return {
      submitted: true,
      answered: interview.answers.length,
      totalQuestions: interview.questions.length,
      complete: interview.complete,
      feedback: this.createFeedback(response, score),
      summary: interview.complete ? this.createSummary(interview) : null
    };
  }

  completeInterview(id, owner) {
    const interview = this.getSession(id, owner);
    if (!interview.complete || interview.answers.length !== interview.questions.length) {
      throw new InterviewError("Answer all 10 questions before completing the interview.", 409);
    }
    return {
      id: interview.id,
      complete: true,
      summary: this.createSummary(interview)
    };
  }

  toPublicInterview(interview) {
    const currentQuestion = interview.complete
      ? null
      : interview.questions[interview.questionIndex];
    return {
      id: interview.id,
      focus: interview.focus,
      questionNumber: interview.complete ? interview.questions.length : interview.questionIndex + 1,
      totalQuestions: interview.questions.length,
      currentQuestion: currentQuestion?.question || null,
      questionId: currentQuestion?.id ?? null,
      complete: interview.complete,
      summary: interview.complete ? this.createSummary(interview) : null
    };
  }

  validateOwner(interview, owner) {
    if (owner && interview.owner !== owner) {
      throw new InterviewError("You cannot access this interview.", 403);
    }
  }

  getSession(id, owner) {
    this.removeExpiredSessions();
    const interview = this.sessions.get(id);
    if (!interview) {
      throw new InterviewError("Interview not found or expired.", 404);
    }
    this.validateOwner(interview, owner);
    interview.expiresAt = Date.now() + INTERVIEW_TTL_MS;
    return interview;
  }

  removeExpiredSessions() {
    const now = Date.now();
    for (const [id, interview] of this.sessions) {
      if (interview.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  scoreAnswer(answer) {
    const words = answer.split(/\s+/).filter(Boolean);
    const hasExample = /\b(for example|for instance|such as|when i|i built|i led|i created)\b/i.test(answer);
    const hasOutcome = /\b(result|improved|reduced|increased|learned|impact|outcome|because)\b/i.test(answer);

    return Math.min(5, 2 + Number(words.length >= 40) + Number(hasExample) + Number(hasOutcome));
  }

  createFeedback(answer, score) {
    const wordCount = answer.split(/\s+/).filter(Boolean).length;
    if (wordCount < 15) {
      return "Try adding more detail: explain the situation, the actions you took, and the result.";
    }
    if (score >= 4) {
      return "Good detail. You included context and supporting specifics; make the outcome easy to remember.";
    }
    return "A solid start. Add a concrete example and explain the impact or what you learned.";
  }

  createSummary(interview) {
    const totalScore = interview.answers.reduce((sum, item) => sum + item.score, 0);
    const averageScore = totalScore / interview.answers.length;
    let overallFeedback = "Review your answers and look for places to add specific examples.";

    if (averageScore >= 4) {
      overallFeedback = "Your answers included useful detail. Keep practicing concise, result-focused examples.";
    } else if (averageScore < 3) {
      overallFeedback = "Practice structuring answers with context, your actions, and the outcome.";
    }

    return {
      answered: interview.answers.length,
      totalQuestions: interview.questions.length,
      averageScore: Number(averageScore.toFixed(1)),
      overallFeedback,
      scoringNote: "Practice-only estimate based on answer detail, examples, and outcomes; not an AI evaluation."
    };
  }
}

module.exports = { InterviewError, InterviewService };
