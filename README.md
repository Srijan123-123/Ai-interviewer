# Clearview Interview Practice

Clearview is a local Node.js interview practice app. Candidates sign in, upload a resume, and generate ten personalized technical interview questions. Resume analysis and the full question set stay on the backend; the candidate receives only the current question. Answers are recorded in the browser, transcribed by the configured AI provider, and kept temporarily for the practice recap.

## Requirements

- Node.js 18 or newer
- An OpenAI API key with access to the configured model

## Configure and run

Install dependencies from the project directory:

```powershell
npm install
```

Create a local `.env` file from the template:

```powershell
Copy-Item .env.example .env
```

Set `AI_API_KEY` to your AI provider API key and `AI_MODEL` to a model available to your account. Set `MONGO_URL` to your MongoDB Atlas connection string and `JWT_SECRET` to a stable random secret of at least 32 bytes. Generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. The app loads `.env` from the project root when the backend starts. Alternatively, set these variables in the backend process environment. Restart the server after changing them. Never commit `.env` or share its values. Keep the same `JWT_SECRET` across deploys, or all existing sign-in tokens will stop validating.

Check the MongoDB connection and initialize the authentication collections and indexes with:

```powershell
npm run db:check
```

The backend creates `users`, `sessions`, `resume_analyses`, `interviews`, and `proctoring_sessions` collections. MongoDB indexes enforce unique emails and JWT IDs and expire analysis, interview, proctoring, and session records automatically. Resume analysis and interview collections also have owner indexes. On startup it imports any existing accounts from `backend/data/accounts.json` into MongoDB without replacing existing MongoDB accounts.

The optional `AI_API_URL` defaults to `https://api.openai.com/v1/chat/completions`. It may be changed for an OpenAI-compatible endpoint; remote URLs must use HTTPS. Audio transcription uses `AI_TRANSCRIPTION_MODEL` and an endpoint derived from `AI_API_URL` by default (Groq: `whisper-large-v3-turbo`; OpenAI: `whisper-1`). Set `AI_TRANSCRIPTION_URL` to override the transcription endpoint. For PowerShell-only configuration instead of `.env`:

```powershell
$env:AI_API_KEY = "your-openai-api-key"
$env:AI_MODEL = "gpt-4o-mini"
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). For automatic server restarts during development, use `npm run dev`. Run tests with `npm test`.

The API key is read only by the backend and is never sent to the browser or written to application logs. `.env` is ignored by Git; do not put credentials in frontend files or commit them. Resume text and recorded audio are sent to the configured AI provider for analysis, question generation, and transcription; review that provider's data-handling and retention terms before using real candidate data.

## Candidate workflow

1. Register or sign in with an email and a password of at least 12 characters.
2. Read and accept the camera policy, enable the camera, capture a still photo, preview it, and confirm the upload.
3. Enable the microphone, check the live input-level meter, make and play a short local test recording, then confirm the microphone.
4. Upload a PDF, DOCX, TXT, or Markdown resume (up to 5 MB).
5. Wait for the upload and analysis success statuses. Resume details remain private and are not displayed.
6. Choose **Generate 10 Interview Questions**. Each question includes its category and difficulty. Regenerate the set if needed.
7. Start the voice interview. Only the current question is sent to the browser. The verified camera remains active; if a page refresh interrupts the camera, reconnect it before continuing.
8. Each exact question is narrated in English using the browser's speech synthesis when an English voice is available. The 10-second preparation countdown begins after narration finishes. **Replay Question** or mute/unmute question audio before recording; voice narration never reads candidate answers or resume details. If speech synthesis or an English voice is unavailable, the interview continues silently with the existing countdown. Recording starts automatically after the preparation period and stops at five minutes. Submit early at any time, or let the timer submit automatically. The backend transcribes and saves each recording before revealing and narrating the next question.

The active interview ID is kept in the current browser tab so a refresh can resume the same backend-controlled question. Finalized audio waiting for submission is temporarily stored in browser IndexedDB so it can be retried after a refresh; it is deleted after the answer is accepted. If the page is refreshed while the microphone is actively recording, that unfinished recording cannot be resumed, but the interview remains on the same question and the candidate is prompted to record again.

The backend extracts resume text in memory and does not save the original file or extracted text. Structured analysis and generated questions are stored in MongoDB for up to 30 minutes and are bound to the signed-in account. Audio uploads are processed in memory and discarded after transcription; transcripts are stored in MongoDB with the interview for up to two hours (refreshed while active). Verification photos and consent/proctoring status are stored in MongoDB for up to 24 hours (refreshed during active use); photos are not sent to an AI service or used for face recognition. The microphone check is local to the browser, and its temporary recording is discarded after the candidate continues or closes the page. Account records and JWT session revocation IDs are stored in MongoDB; passwords are salted and hashed using Node.js `scrypt`. The app issues signed HS256 JWTs in an HttpOnly, SameSite=Strict cookie with a 12-hour expiry. The JWT secret must remain stable, and the session record allows logout and revocation before expiry. MongoDB TTL indexes expire these records; deletion by a TTL index runs asynchronously. The app waits for MongoDB persistence before sending responses that change or refresh this workflow state.

Question generation and resume analysis use the configured OpenAI model. Missing configuration, invalid credentials, insufficient credits, rate limits, and other provider failures return actionable errors and do not fall back to mock data. The existing answer feedback and recap are practice-only heuristics; they are not generated by AI and are not a technical evaluation.

## API

Resume analysis, question generation, and interview creation require a valid sign-in session and completed camera/microphone verification.

- `POST /api/auth/register` — create an account with `email` and `password`, then sign in.
- `POST /api/auth/login` — authenticate with `email` and `password`.
- `GET /api/auth/session` — check the current sign-in session.
- `POST /api/auth/logout` — end the current sign-in session.
- `POST /api/resume/analyze` — accept `filename` and base64-encoded `contentBase64`; return an `analysisId` and analysis status. Structured analysis remains on the backend.
- `POST /api/interviews/generate-questions` — accept `analysisId`; generate and store ten unique questions server-side, returning only a ready status and count.
- `POST /api/interviews` — accept `analysisId` after question generation; create a sequential interview and return only question 1.
- `GET /api/interviews/:id/current-question` — return the currently issued question and progress.
- `GET /api/interviews/:id/next-question` — return the next question only after the current answer was submitted.
- `POST /api/interviews/:id/answers` — accept multipart fields `questionId`, idempotent `submissionId`, and `audio`; transcribe and store the answer before advancing.
- `POST /api/interviews/:id/complete` — return the completion recap after all ten answers.
- `POST /api/proctoring/consent` — store the candidate's consent and policy version.
- `POST /api/proctoring/verification` — accept a verification image and store the still photo associated with the authenticated user.
- `POST /api/proctoring/microphone-verification` — record completion of the local microphone test for the authenticated user.
- `POST /api/proctoring/events` — append browser/camera warnings with timestamps for review.
- `GET /api/proctoring/session` — return the session consent/verification status for the authenticated user.

## Project structure

- `frontend/` contains the browser interface, styles, status-only resume upload flow, and sequential voice recording experience.
- `backend/` contains authentication, resume extraction, AI services, analysis/question validation, the HTTP server, and tests.
- `backend/proctoring.js` holds authenticated consent, verification, session status, and reviewable proctoring events in memory.
