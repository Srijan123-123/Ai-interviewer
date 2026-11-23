const test = require("node:test");
const assert = require("node:assert/strict");
const { AiService, AiServiceError } = require("./ai");

const ANALYSIS = {
  candidate: {
    name: "Alex Doe",
    education: [
      {
        degree: "BSc",
        specialization: "Computer Science",
        institution: "Example University",
        graduation_year: "2025"
      }
    ]
  },
  skills: {
    programming_languages: ["JavaScript"],
    frameworks_libraries: ["React", "Node.js"],
    databases: ["MySQL"],
    development_tools: [],
    ai_ml: [],
    electronics_embedded: [],
    industrial_automation: [],
    other_technical_skills: []
  },
  projects: [
    {
      title: "Live Badminton Scoring Platform",
      objective: "Track badminton scores.",
      problem_solved: "Manual score tracking.",
      technologies: ["React", "Node.js", "MySQL"],
      implementation: "A web application.",
      individual_contribution: "Built the API.",
      key_features: ["Score tracking"],
      challenges: [],
      outcomes: []
    }
  ],
  experience: [],
  certifications_workshops: [],
  resume_summary: "A software developer with experience building a scoring platform."
};

function createQuestions() {
  const categories = [
    "Project Architecture",
    "Project Architecture",
    "Technologies and Tools",
    "Technologies and Tools",
    "Core Technical Concepts",
    "Core Technical Concepts",
    "Practical Implementation",
    "Problem Solving",
    "Advanced Scenarios",
    "Advanced Scenarios"
  ];
  const evidenceIds = [
    ["PROJECT_001"],
    ["PROJECT_001"],
    ["SKILL_002"],
    ["SKILL_003"],
    ["SKILL_004"],
    ["SKILL_001"],
    ["SKILL_003"],
    ["SKILL_004"],
    ["SKILL_002"],
    ["SKILL_004"]
  ];
  const prompts = [
    "How would you redesign live score updates to prevent conflicting match results?",
    "Which architecture would help the badminton platform support more simultaneous matches?",
    "How could React keep a match scoreboard responsive as scores change?",
    "What Node.js change would help isolate failures while a match is being updated?",
    "How can MySQL transactions protect score tracking from partial writes?",
    "How would JavaScript handle a score update that arrives after a newer update?",
    "How could Node.js recover safely if score persistence fails mid-request?",
    "What MySQL index would help locate a player's historical match scores?",
    "How could React present a stale score while a network retry is pending?",
    "How would you migrate the MySQL score records without interrupting active matches?"
  ];
  return categories.map((category, index) => ({
    id: index + 1,
    question: prompts[index],
    category,
    difficulty: index < 3 ? "Beginner" : index < 7 ? "Intermediate" : "Advanced",
    evidence_ids: evidenceIds[index]
  }));
}

function makeService(content) {
  let requestOptions;
  const service = new AiService({
    apiKey: "test-secret",
    model: "test-model",
    apiUrl: "https://ai.example.test/v1/chat/completions",
    fetchImpl: async (url, options) => {
      requestOptions = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] })
      };
    }
  });
  return { service, getRequestOptions: () => requestOptions };
}

test("analyzes resume text into the validated structured response", async () => {
  const { service, getRequestOptions } = makeService(ANALYSIS);
  const result = await service.analyzeResume("Resume data supplied only for this test.");

  const { facts, ...analysis } = result;
  assert.deepEqual(analysis, ANALYSIS);
  assert.deepEqual(facts.map((fact) => fact.id), [
    "SKILL_001",
    "SKILL_002",
    "SKILL_003",
    "SKILL_004",
    "PROJECT_001"
  ]);
  assert.equal(getRequestOptions().options.headers.Authorization, "Bearer test-secret");
  assert.match(getRequestOptions().options.body, /response_format/);
});

test("generates exactly ten unique, resume-grounded questions", async () => {
  const expectedQuestions = createQuestions();
  const { service } = makeService({ questions: expectedQuestions });
  const result = await service.generateQuestions(ANALYSIS);

  assert.deepEqual(result, expectedQuestions);
  assert.equal(result.length, 10);
  assert.equal(new Set(result.map((question) => question.question)).size, 10);
});

test("generates questions using natural wording grounded by internal evidence", async () => {
  const questions = createQuestions();
  const { service } = makeService({ questions });
  const result = await service.generateQuestions(ANALYSIS);

  assert.equal(result.length, 10);
  assert.equal(result[0].question, "How would you redesign live score updates to prevent conflicting match results?");
});

test("accepts semantic variations supported by a cited resume fact", async () => {
  const questions = createQuestions();
  questions[0].question = "How could parallel match updates improve badminton point consistency?";
  const { service } = makeService({ questions });

  const result = await service.generateQuestions(ANALYSIS);
  assert.equal(result[0].question, questions[0].question);
});

test("accepts an interview prompt phrased without trailing punctuation", async () => {
  const questions = createQuestions();
  questions[0].question = "Describe how live score updates could avoid conflicting match results";
  const { service } = makeService({ questions });

  const result = await service.generateQuestions(ANALYSIS);
  assert.equal(result[0].question, questions[0].question);
});

test("parses questions nested in a provider JSON wrapper", async () => {
  const { service } = makeService({ result: { data: { questions: createQuestions() } } });

  const result = await service.generateQuestions(ANALYSIS);
  assert.equal(result.length, 10);
});

test("parses a JSON array response", async () => {
  const { service } = makeService(createQuestions());

  const result = await service.generateQuestions(ANALYSIS);
  assert.equal(result.length, 10);
});

test("regenerates only invalid question ids and keeps accepted questions", async () => {
  const questions = createQuestions();
  questions[0].evidence_ids = ["UNKNOWN_001"];
  const requestedIds = [];
  let call = 0;
  const service = new AiService({
    apiKey: "test-secret",
    model: "test-model",
    fetchImpl: async (url, options) => {
      call += 1;
      const request = JSON.parse(options.body);
      const prompt = request.messages[1].content;
      const idsMatch = prompt.match(/Generate questions only for these ids: (\[[^\]]+\])/u);
      requestedIds.push(JSON.parse(idsMatch[1]));
      const resultQuestions = call === 1 ? questions : [createQuestions()[0]];
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ questions: resultQuestions }) } }] })
      };
    }
  });

  const result = await service.generateQuestions(ANALYSIS);
  assert.equal(result.length, 10);
  assert.deepEqual(requestedIds[0], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(requestedIds[1], [1]);
});

test("retries a question with missing fields and includes the failure in the retry context", async () => {
  const firstBatch = createQuestions();
  delete firstBatch[0].evidence_ids;
  const prompts = [];
  let call = 0;
  const service = new AiService({
    apiKey: "test-secret",
    model: "test-model",
    fetchImpl: async (url, options) => {
      call += 1;
      const request = JSON.parse(options.body);
      prompts.push(request.messages[1].content);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({ questions: call === 1 ? firstBatch : [createQuestions()[0]] })
            }
          }]
        })
      };
    }
  });

  const result = await service.generateQuestions(ANALYSIS);
  assert.equal(result.length, 10);
  assert.match(prompts[1], /missing_fields/u);
  assert.match(prompts[1], /How would you redesign live score updates/u);
  assert.match(prompts[0], /"id":"PROJECT_001"/u);
});

test("regenerates a duplicate question without discarding the other valid questions", async () => {
  const firstBatch = createQuestions();
  firstBatch[9].question = firstBatch[8].question;
  const requestedIds = [];
  let call = 0;
  const service = new AiService({
    apiKey: "test-secret",
    model: "test-model",
    fetchImpl: async (url, options) => {
      call += 1;
      const request = JSON.parse(options.body);
      const idsMatch = request.messages[1].content.match(/Generate questions only for these ids: (\[[^\]]+\])/u);
      requestedIds.push(JSON.parse(idsMatch[1]));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({ questions: call === 1 ? firstBatch : [createQuestions()[9]] })
            }
          }]
        })
      };
    }
  });

  const result = await service.generateQuestions(ANALYSIS);
  assert.equal(result.length, 10);
  assert.deepEqual(requestedIds[1], [10]);
  assert.equal(new Set(result.map((question) => question.question)).size, 10);
});

test("reports a missing API key instead of returning fallback analysis", async () => {
  const service = new AiService({ apiKey: "", model: "test-model" });

  await assert.rejects(
    () => service.analyzeResume("Resume text"),
    (error) =>
      error instanceof AiServiceError &&
      error.statusCode === 503 &&
      /AI_API_KEY/u.test(error.message)
  );
});

test("reports a missing model instead of returning fallback analysis", async () => {
  const service = new AiService({ apiKey: "test-key", model: "" });

  await assert.rejects(
    () => service.analyzeResume("Resume text"),
    (error) => error instanceof AiServiceError && /AI_MODEL/u.test(error.message)
  );
});

test("reports AI provider failures without leaking credentials", async () => {
  const service = new AiService({
    apiKey: "private-test-key",
    model: "test-model",
    fetchImpl: async () => ({ ok: false, status: 401 })
  });

  await assert.rejects(
    () => service.analyzeResume("Resume text"),
    (error) =>
      error instanceof AiServiceError &&
      error.statusCode === 502 &&
      !error.message.includes("private-test-key")
  );
});

test("provides actionable errors for invalid credentials, credits, and rate limits", async () => {
  const providerFailures = [
    {
      status: 401,
      body: { error: { message: "Invalid key" } },
      expected: /AI_API_KEY/u
    },
    {
      status: 429,
      body: { error: { code: "insufficient_quota", message: "No credits" } },
      expected: /insufficient API credits/u
    },
    {
      status: 429,
      body: { error: { code: "rate_limit_exceeded", message: "Slow down" } },
      expected: /rate limit/u
    }
  ];

  for (const failure of providerFailures) {
    const service = new AiService({
      apiKey: "private-test-key",
      model: "test-model",
      fetchImpl: async () => ({
        ok: false,
        status: failure.status,
        json: async () => failure.body
      })
    });

    await assert.rejects(
      () => service.analyzeResume("Resume text"),
      (error) =>
        error instanceof AiServiceError &&
        failure.expected.test(error.message) &&
        !error.message.includes("private-test-key")
    );
  }
});

test("reports malformed AI JSON as a provider response error", async () => {
  const service = new AiService({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "{not valid json}" } }] })
    })
  });
  await assert.rejects(
    () => service.analyzeResume("Resume text"),
    (error) => error instanceof AiServiceError && /malformed JSON/u.test(error.message)
  );
});

test("accepts JSON wrapped in a Markdown fence and retries malformed question JSON", async () => {
  let calls = 0;
  const questions = createQuestions();
  const service = new AiService({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: calls === 1
                ? "```json\n{ malformed }\n```"
                : `\n \`\`\`json\n${JSON.stringify({ questions })}\n\`\`\` `
            }
          }]
        })
      };
    }
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await service.generateQuestions(ANALYSIS);
    assert.equal(result.length, 10);
    assert.equal(calls, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test("fails with a useful message after two malformed-response retries", async () => {
  let calls = 0;
  const service = new AiService({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "```json\nnot json\n```" } }] })
      };
    }
  });
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      () => service.generateQuestions(ANALYSIS),
      (error) =>
        error instanceof AiServiceError &&
        /after two retries/u.test(error.message) &&
        error.category === "malformed_json"
    );
    assert.equal(calls, 3);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test("refuses to send provider credentials to a non-HTTPS remote endpoint", async () => {
  let requestMade = false;
  const service = new AiService({
    apiKey: "private-test-key",
    model: "test-model",
    apiUrl: "http://ai.example.test/v1/chat/completions",
    fetchImpl: async () => {
      requestMade = true;
      return { ok: true, json: async () => ({}) };
    }
  });

  await assert.rejects(
    () => service.analyzeResume("Resume text"),
    (error) => error instanceof AiServiceError && error.statusCode === 503
  );
  assert.equal(requestMade, false);
});

test("transcribes audio through the configured provider using server-side credentials", async () => {
  let requestUrl;
  let requestOptions;
  const service = new AiService({
    apiKey: "private-test-key",
    model: "test-model",
    apiUrl: "https://api.groq.com/openai/v1/chat/completions",
    fetchImpl: async (url, options) => {
      requestUrl = url.toString();
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: "A private spoken answer." })
      };
    }
  });

  const transcript = await service.transcribeAudio(Buffer.from("audio bytes"), "audio/webm", "answer.webm");
  assert.equal(transcript, "A private spoken answer.");
  assert.equal(requestUrl, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(requestOptions.headers.Authorization, "Bearer private-test-key");
  assert.ok(requestOptions.body instanceof FormData);
  assert.equal(requestOptions.body.get("model"), "whisper-large-v3-turbo");
  assert.equal(requestOptions.body.get("response_format"), "json");
  assert.equal(requestOptions.body.get("file").type, "audio/webm");
});

test("rejects empty or malformed transcription responses without submitting an answer", async () => {
  for (const responseBody of [{ text: " " }, { result: "No text field" }]) {
    const service = new AiService({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => responseBody
      })
    });
    await assert.rejects(
      () => service.transcribeAudio(Buffer.from("audio"), "audio/webm"),
      (error) => error instanceof AiServiceError && error.category === "empty_transcript"
    );
  }
});
