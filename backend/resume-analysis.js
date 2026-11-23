const { randomUUID } = require("node:crypto");
const { extractResume } = require("./resume");
const { AiService } = require("./ai");
const { InterviewError } = require("./interview");

const ANALYSIS_TTL_MS = 30 * 60 * 1000;
const MAX_ANALYSES = 100;

class ResumeAnalysisService {
  constructor({ aiService = new AiService(), extractResumeFn = extractResume } = {}) {
    this.aiService = aiService;
    this.extractResume = extractResumeFn;
    this.analyses = new Map();
  }

  async analyze(upload, owner) {
    this.validateOwner(owner);
    this.removeExpiredAnalyses();
    const resumeText = await this.extractResume(upload);
    const analysis = await this.aiService.analyzeResume(resumeText);
    const analysisId = randomUUID();

    this.analyses.set(analysisId, {
      owner,
      analysis,
      questions: null,
      expiresAt: Date.now() + ANALYSIS_TTL_MS
    });
    this.enforceAnalysisLimit();

    return { analysisId, analyzed: true };
  }

  async generateQuestions(analysisId, owner) {
    const entry = this.getEntry(analysisId, owner);
    const questions = await this.aiService.generateQuestions(entry.analysis);
    entry.questions = questions;
    entry.expiresAt = Date.now() + ANALYSIS_TTL_MS;
    return {
      generated: true,
      questionCount: questions.length
    };
  }

  getAnalysis(analysisId, owner) {
    return this.getEntry(analysisId, owner).analysis;
  }

  getGeneratedQuestions(analysisId, owner) {
    const entry = this.getEntry(analysisId, owner);
    if (!entry.questions) {
      throw new InterviewError("Generate interview questions before starting the interview.", 409);
    }
    entry.expiresAt = Date.now() + ANALYSIS_TTL_MS;
    return entry.questions;
  }

  getEntry(analysisId, owner) {
    this.validateOwner(owner);
    this.removeExpiredAnalyses();
    if (typeof analysisId !== "string" || !/^[0-9a-f-]{36}$/i.test(analysisId)) {
      throw new InterviewError("Resume analysis not found.", 404);
    }
    const entry = this.analyses.get(analysisId);
    if (!entry) {
      throw new InterviewError("Resume analysis not found or expired. Upload your resume again.", 404);
    }
    if (entry.owner !== owner) {
      throw new InterviewError("You cannot access this resume analysis.", 403);
    }
    return entry;
  }

  validateOwner(owner) {
    if (typeof owner !== "string" || !owner) {
      throw new InterviewError("Sign in to analyze a resume.", 401);
    }
  }

  removeExpiredAnalyses() {
    const now = Date.now();
    for (const [analysisId, entry] of this.analyses) {
      if (entry.expiresAt <= now) {
        this.analyses.delete(analysisId);
      }
    }
  }

  enforceAnalysisLimit() {
    while (this.analyses.size > MAX_ANALYSES) {
      this.analyses.delete(this.analyses.keys().next().value);
    }
  }
}

module.exports = { ResumeAnalysisService };
