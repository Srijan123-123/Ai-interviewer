const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const http = require("node:http");
const fs = require("node:fs");
const { AuthError, AuthService } = require("./auth");
const { AiService, AiServiceError } = require("./ai");
const { InterviewError, InterviewService } = require("./interview");
const { ResumeAnalysisService } = require("./resume-analysis");
const { ProctoringError, ProctoringService } = require("./proctoring");
const { AppPersistence } = require("./app-persistence");
const { MAX_RESUME_BYTES } = require("./resume");

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESUME_REQUEST_BYTES = Math.ceil(MAX_RESUME_BYTES / 3) * 4 + 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const SESSION_COOKIE = "clearview_session";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function sendJson(response, statusCode, data) {
  if (response.persistState) {
    try {
      await response.persistState();
    } catch (error) {
      console.error("Could not persist application state.", { name: error.name, code: error.code });
      statusCode = 503;
      data = { error: "Could not save your progress. Please retry." };
    }
  }
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function getSessionToken(request) {
  const cookies = request.headers.cookie || "";
  const sessionCookie = cookies.split(";").map((cookie) => cookie.trim()).find((cookie) =>
    cookie.startsWith(`${SESSION_COOKIE}=`)
  );
  const token = sessionCookie?.slice(SESSION_COOKIE.length + 1);
  return token && /^[0-9a-f]{64}$/i.test(token) ? token : null;
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`
  );
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  );
}

function readJsonBody(request, maxBodyBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyLength = 0;
    let exceededLimit = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (exceededLimit) {
        return;
      }
      bodyLength += Buffer.byteLength(chunk, "utf8");
      if (bodyLength > maxBodyBytes) {
        exceededLimit = true;
        body = "";
        reject(new InterviewError("Request body is too large.", 413));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (exceededLimit) {
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new InterviewError("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function readBufferBody(
  request,
  maxBodyBytes,
  sizeErrorMessage = "Audio upload exceeds the 10 MB limit. Record a shorter answer."
) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let exceededLimit = false;
    request.on("data", (chunk) => {
      if (exceededLimit) {
        return;
      }
      length += chunk.length;
      if (length > maxBodyBytes) {
        exceededLimit = true;
        reject(new InterviewError(sizeErrorMessage, 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!exceededLimit) {
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("error", reject);
  });
}

function parseProctoringImageMultipart(buffer, contentType) {
  const boundaryMatch = typeof contentType === "string"
    ? contentType.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu)
    : null;
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) {
    throw new InterviewError("Verification upload must use multipart/form-data.", 400);
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from("\r\n\r\n");
  const nextPart = Buffer.from(`\r\n--${boundary}`);
  let cursor = buffer.indexOf(delimiter);
  if (cursor < 0) {
    throw new InterviewError("The verification upload is malformed.", 400);
  }
  cursor += delimiter.length;

  while (cursor < buffer.length) {
    if (buffer.subarray(cursor, cursor + 2).toString() === "--") {
      break;
    }
    if (buffer.subarray(cursor, cursor + 2).toString() === "\r\n") {
      cursor += 2;
    }
    const headersEnd = buffer.indexOf(separator, cursor);
    if (headersEnd < 0) {
      throw new InterviewError("The verification upload is malformed.", 400);
    }
    const headersText = buffer.subarray(cursor, headersEnd).toString("utf8");
    const partEnd = buffer.indexOf(nextPart, headersEnd + separator.length);
    if (partEnd < 0) {
      throw new InterviewError("The verification upload is malformed.", 400);
    }
    const content = buffer.subarray(headersEnd + separator.length, partEnd);
    const disposition = headersText.match(/content-disposition:\s*form-data;([^\r\n]+)/iu)?.[1] || "";
    const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/iu)?.[1];
    const mimeType = headersText.match(/content-type:\s*([^\r\n;]+)/iu)?.[1]?.trim().toLowerCase();
    if (name === "image" || name === "photo") {
      const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/iu)?.[1] || "verification.png";
      if (!mimeType || !(mimeType.startsWith("image/") || mimeType === "application/octet-stream")) {
        throw new InterviewError("The verification photo must be a valid image file.", 400);
      }
      if (!content.length || content.length > 5 * 1024 * 1024) {
        throw new InterviewError("The verification photo must be smaller than 5 MB.", 413);
      }
      return { image: content, mimeType, filename: filename.slice(0, 120) };
    }
    cursor = partEnd + 2 + delimiter.length;
  }

  throw new InterviewError("The verification upload must include an image field.", 400);
}

function parseAudioMultipart(buffer, contentType) {
  const boundaryMatch = typeof contentType === "string"
    ? contentType.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu)
    : null;
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) {
    throw new InterviewError("Answer upload must use multipart/form-data.", 400);
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from("\r\n\r\n");
  const nextPart = Buffer.from(`\r\n--${boundary}`);
  const fields = new Map();
  let audio = null;
  let cursor = buffer.indexOf(delimiter);
  if (cursor < 0) {
    throw new InterviewError("The audio upload is malformed.", 400);
  }
  cursor += delimiter.length;

  while (cursor < buffer.length) {
    if (buffer.subarray(cursor, cursor + 2).toString() === "--") {
      break;
    }
    if (buffer.subarray(cursor, cursor + 2).toString() === "\r\n") {
      cursor += 2;
    }
    const headersEnd = buffer.indexOf(separator, cursor);
    if (headersEnd < 0) {
      throw new InterviewError("The audio upload is malformed.", 400);
    }
    const headersText = buffer.subarray(cursor, headersEnd).toString("utf8");
    const partEnd = buffer.indexOf(nextPart, headersEnd + separator.length);
    if (partEnd < 0) {
      throw new InterviewError("The audio upload is malformed.", 400);
    }
    const content = buffer.subarray(headersEnd + separator.length, partEnd);
    const disposition = headersText.match(/content-disposition:\s*form-data;([^\r\n]+)/iu)?.[1] || "";
    const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/iu)?.[1];
    if (name === "audio") {
      if (audio) {
        throw new InterviewError("Submit one audio recording per answer.", 400);
      }
      const mimeType = headersText.match(/content-type:\s*([^\r\n;]+)/iu)?.[1]?.trim().toLowerCase();
      const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/iu)?.[1] || "answer.webm";
      if (
        !mimeType ||
        (!mimeType.startsWith("audio/") && !(mimeType === "video/webm")) ||
        !content.length ||
        content.length > MAX_AUDIO_BYTES
      ) {
        throw new InterviewError("Record a valid audio answer smaller than 10 MB.", 400);
      }
      audio = { bytes: content, mimeType, filename: filename.slice(0, 120) };
    } else if (name === "questionId" || name === "submissionId") {
      if (fields.has(name)) {
        throw new InterviewError("The audio upload contains duplicate submission fields.", 400);
      }
      fields.set(name, content.toString("utf8").trim());
    }
    cursor = partEnd + 2 + delimiter.length;
  }

  const questionId = fields.get("questionId");
  const submissionId = fields.get("submissionId");
  if (!questionId || !submissionId || !audio) {
    throw new InterviewError("Include the current question ID, submission ID, and a recorded audio answer.", 400);
  }
  return { questionId, submissionId, ...audio };
}

function serveFrontend(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(FRONTEND_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${FRONTEND_DIR}${path.sep}`)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, {
        error: error.code === "ENOENT" ? "File not found." : "Unable to read frontend file."
      });
      if (error.code !== "ENOENT") {
        console.error("Frontend file error:", error);
      }
      return;
    }

    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : content);
  });
}

async function handleRequest(request, response, services) {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  } catch {
    sendJson(response, 400, { error: "Invalid request URL." });
    return;
  }

  try {
    await services.ready;
    if (url.pathname.startsWith("/api/resume/") || url.pathname.startsWith("/api/interviews") || url.pathname.startsWith("/api/proctoring/")) {
      response.persistState = () => services.persistence?.persist(services);
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      sendJson(response, 200, { user: await services.authService.getUser(getSessionToken(request)) });
      return;
    }

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      const body = await readJsonBody(request);
      const result = await services.authService.register(body.email, body.password);
      setSessionCookie(response, result.sessionToken);
      sendJson(response, 201, { user: result.user });
      return;
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const body = await readJsonBody(request);
      const result = await services.authService.login(body.email, body.password);
      setSessionCookie(response, result.sessionToken);
      sendJson(response, 200, { user: result.user });
      return;
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      await services.authService.logout(getSessionToken(request));
      clearSessionCookie(response);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname.startsWith("/api/auth/")) {
      sendJson(response, 404, { error: "Authentication route not found." });
      return;
    }

    if (url.pathname === "/api/proctoring/consent" && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, services.proctoringService.saveConsent(
        user.email,
        body?.consent,
        body?.policyVersion || "2026-01"
      ));
      return;
    }

    if (url.pathname === "/api/proctoring/verification" && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      let imageDataUrl;
      const contentType = request.headers["content-type"] || "";
      if (/^multipart\/form-data\b/iu.test(contentType)) {
        const body = await readBufferBody(
          request,
          5 * 1024 * 1024 + 1024,
          "Verification photo exceeds the 5 MB limit."
        );
        const parsed = parseProctoringImageMultipart(body, contentType);
        imageDataUrl = parsed?.image ? `data:${parsed.mimeType};base64,${parsed.image.toString("base64")}` : null;
      } else {
        const body = await readJsonBody(request, 7 * 1024 * 1024);
        imageDataUrl = body?.imageDataUrl || body?.image;
      }
      if (!imageDataUrl) {
        throw new InterviewError("A verification photograph is required.", 400);
      }
      sendJson(response, 201, services.proctoringService.saveVerification(user.email, imageDataUrl));
      return;
    }

    if (url.pathname === "/api/proctoring/microphone-verification" && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, services.proctoringService.verifyMicrophone(user.email, body?.verified));
      return;
    }

    if (url.pathname === "/api/proctoring/events" && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      const body = await readJsonBody(request, 64 * 1024);
      const eventType = typeof body?.type === "string" ? body.type : "unknown_event";
      const details = body && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};
      sendJson(response, 201, services.proctoringService.recordEvent(user.email, eventType, details));
      return;
    }

    if ((url.pathname === "/api/proctoring/session" || url.pathname === "/api/proctoring/session/") && request.method === "GET") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      sendJson(response, 200, services.proctoringService.getSessionStatus(user.email));
      return;
    }

    if (url.pathname === "/api/resume/analyze" && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      services.proctoringService.assertInterviewReady(user.email);
      const body = await readJsonBody(request, MAX_RESUME_REQUEST_BYTES);
      sendJson(response, 201, await services.resumeAnalysisService.analyze(body, user.email));
      return;
    }

    if (url.pathname === "/api/interviews/generate-questions" && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      services.proctoringService.assertInterviewReady(user.email);
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new InterviewError("Request body must be a JSON object.");
      }
      sendJson(
        response,
        200,
        await services.resumeAnalysisService.generateQuestions(body.analysisId, user.email)
      );
      return;
    }

    if (url.pathname === "/api/interviews" && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      services.proctoringService.assertInterviewReady(user.email);
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new InterviewError("Request body must be a JSON object.");
      }
      services.resumeAnalysisService.getAnalysis(body.analysisId, user.email);
      const questions = services.resumeAnalysisService.getGeneratedQuestions(body.analysisId, user.email);
      sendJson(response, 201, {
        interview: services.interviewService.createInterview({
          questions,
          focus: "Technical interview practice",
          owner: user.email
        })
      });
      return;
    }

    const interviewActionMatch = url.pathname.match(/^\/api\/interviews\/([0-9a-f-]+)\/(current-question|next-question|complete)$/i);
    if (interviewActionMatch) {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      const [, interviewId, action] = interviewActionMatch;
      if (action === "current-question" && request.method === "GET") {
        sendJson(response, 200, services.interviewService.getCurrentQuestion(interviewId, user.email));
        return;
      }
      if (action === "next-question" && request.method === "GET") {
        sendJson(response, 200, services.interviewService.getNextQuestion(interviewId, user.email));
        return;
      }
      if (action === "complete" && request.method === "POST") {
        sendJson(response, 200, services.interviewService.completeInterview(interviewId, user.email));
        return;
      }
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    const answerMatch = url.pathname.match(/^\/api\/interviews\/([0-9a-f-]+)\/answers$/i);
    if (answerMatch && request.method === "POST") {
      const user = await services.authService.getUser(getSessionToken(request));
      if (!user) {
        sendJson(response, 401, { error: "Please sign in to continue." });
        return;
      }
      const contentType = request.headers["content-type"] || "";
      if (!/^multipart\/form-data\b/iu.test(contentType)) {
        throw new InterviewError("Submit a recorded audio answer using multipart/form-data.", 415);
      }
      const body = parseAudioMultipart(
        await readBufferBody(request, MAX_AUDIO_REQUEST_BYTES),
        contentType
      );
      const reservation = services.interviewService.beginAnswerSubmission(
        answerMatch[1],
        body.questionId,
        body.submissionId,
        user.email
      );
      if (reservation.alreadySubmitted) {
        sendJson(response, 200, reservation.result);
        return;
      }
      try {
        const transcript = await services.aiService.transcribeAudio(
          body.bytes,
          body.mimeType,
          body.filename
        );
        sendJson(
          response,
          200,
          services.interviewService.submitTranscribedAnswer(
            answerMatch[1],
            transcript,
            body.questionId,
            reservation,
            user.email
          )
        );
      } catch (error) {
        services.interviewService.cancelAnswerSubmission(
          answerMatch[1],
          reservation.token,
          user.email
        );
        throw error;
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API route not found." });
      return;
    }

    serveFrontend(request, response, decodeURIComponent(url.pathname));
  } catch (error) {
    if (
      error instanceof InterviewError ||
      error instanceof AuthError ||
      error instanceof AiServiceError ||
      error instanceof ProctoringError
    ) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    if (error instanceof URIError) {
      sendJson(response, 400, { error: "Invalid URL path." });
      return;
    }

    console.error("Request error:", error);
    sendJson(response, 500, { error: "An unexpected server error occurred." });
  }
}

function createServer(overrides = {}) {
  const aiService = overrides.aiService || new AiService();
  const authService = overrides.authService || new AuthService(path.join(__dirname, "data", "accounts.json"));
  const interviewService = overrides.interviewService || new InterviewService();
  const resumeAnalysisService = overrides.resumeAnalysisService || new ResumeAnalysisService({ aiService });
  const proctoringService = overrides.proctoringService || new ProctoringService();
  const persistence = overrides.persistence || (authService.mongoDb ? new AppPersistence(authService.mongoDb) : null);
  const services = {
    authService,
    interviewService,
    resumeAnalysisService,
    proctoringService,
    aiService,
    persistence
  };
  services.ready = Promise.resolve(authService.ready).then(async () => {
    if (!persistence && authService.mongoDb) {
      services.persistence = new AppPersistence(authService.mongoDb);
    }
    if (services.persistence) await services.persistence.initialize(services);
  });
  const server = http.createServer((request, response) => handleRequest(request, response, services));
  server.on("close", () => {
    if (typeof authService.close === "function") void authService.close();
  });
  return { server, services };
}

if (require.main === module) {
  const { server } = createServer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Interviewer is listening on port ${PORT}`);
    console.log("Resume analysis and question generation require AI_API_KEY and AI_MODEL.");
  });
}

module.exports = { createServer };
