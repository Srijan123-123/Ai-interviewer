const test = require("node:test");
const assert = require("node:assert/strict");
const { InterviewError } = require("./interview");
const { ResumeAnalysisService } = require("./resume-analysis");

const ANALYSIS = {
  candidate: { name: "Alex Doe", education: [] },
  skills: {
    programming_languages: [],
    frameworks_libraries: ["React"],
    databases: [],
    development_tools: [],
    ai_ml: [],
    electronics_embedded: [],
    industrial_automation: [],
    other_technical_skills: []
  },
  projects: [],
  experience: [],
  certifications_workshops: [],
  resume_summary: "A frontend developer."
};

const QUESTIONS = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  question: `How did you use React in scenario ${index + 1}?`,
  category: "Technologies and Tools",
  difficulty: "Intermediate",
  resume_reference: "React",
  reason: "Tests use of a resume skill."
}));

function createService() {
  const service = new ResumeAnalysisService({
    extractResumeFn: async (upload) => {
      assert.equal(upload.filename, "resume.txt");
      return "Raw resume content is processed and not returned.";
    },
    aiService: {
      analyzeResume: async (resumeText) => {
        assert.match(resumeText, /Raw resume content/u);
        return ANALYSIS;
      },
      generateQuestions: async (analysis) => {
        assert.equal(analysis, ANALYSIS);
        return QUESTIONS;
      }
    }
  });
  return service;
}

test("keeps analysis and generated questions server-side until the interview starts", async () => {
  const service = createService();
  const result = await service.analyze({ filename: "resume.txt" }, "candidate@example.com");

  assert.deepEqual(result, { analysisId: result.analysisId, analyzed: true });
  assert.deepEqual(service.analyses.get(result.analysisId).analysis, ANALYSIS);
  assert.equal("resumeText" in service.analyses.get(result.analysisId), false);
  assert.throws(
    () => service.getAnalysis(result.analysisId, "other@example.com"),
    (error) => error instanceof InterviewError && error.statusCode === 403
  );
  assert.throws(
    () => service.getGeneratedQuestions(result.analysisId, "candidate@example.com"),
    (error) => error instanceof InterviewError && error.statusCode === 409
  );

  const generated = await service.generateQuestions(result.analysisId, "candidate@example.com");
  assert.deepEqual(generated, { generated: true, questionCount: 10 });
  assert.equal("questions" in generated, false);
  assert.deepEqual(service.getGeneratedQuestions(result.analysisId, "candidate@example.com"), QUESTIONS);
  await assert.rejects(
    () => service.generateQuestions(result.analysisId, "other@example.com"),
    (error) => error instanceof InterviewError && error.statusCode === 403
  );
});

test("rejects expired resume analysis records", async () => {
  const service = createService();
  const result = await service.analyze({ filename: "resume.txt" }, "candidate@example.com");
  service.analyses.get(result.analysisId).expiresAt = Date.now() - 1;

  assert.throws(
    () => service.getAnalysis(result.analysisId, "candidate@example.com"),
    (error) => error instanceof InterviewError && error.statusCode === 404
  );
});
