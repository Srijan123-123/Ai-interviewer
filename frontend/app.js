const app = document.querySelector("#app");
const THINKING_PHASE_MS = 10 * 1000;
const MAX_RECORDING_MS = 5 * 60 * 1000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_RETENTION_MS = 2 * 60 * 60 * 1000;
const TIMER_TICK_MS = 200;
const ACTIVE_INTERVIEW_KEY = "clearview_active_interview";

const state = {
  user: null,
  authMode: "login",
  authBusy: false,
  authError: "",
  interview: null,
  analysisId: null,
  generatedQuestions: null,
  busy: false,
  error: "",
  recorder: null,
  mediaStream: null,
  audioChunks: [],
  audioBlob: null,
  audioUrl: null,
  recordingStartedAt: null,
  timerInterval: null,
  phaseDeadline: null,
  phase: "idle",
  recordingSeconds: 0,
  answerSubmitted: false,
  recordingStatus: "Waiting to record",
  requestingMicrophone: false,
  recordingGeneration: 0,
  submissionId: null,
  autoSubmitOnStop: false,
  activeQuestionId: null,
  questionNarrationGeneration: 0,
  questionNarrationPending: false,
  questionNarrationReturnToThinking: false,
  questionAudioMuted: false,
  questionNarrationUnavailable: false,
  proctoring: {
    consented: false,
    verified: false,
    microphoneVerified: false,
    policyVersion: "2026-01",
    videoStream: null,
    videoReady: false,
    photoDataUrl: "",
    previewVisible: false,
    cameraStatus: "inactive",
    microphoneStatus: "inactive",
    stage: "camera",
    cameraRecheck: false,
    requestBusy: false,
    cameraRequestGeneration: 0,
    microphoneRequestGeneration: 0,
    micStream: null,
    audioContext: null,
    analyser: null,
    meterFrame: null,
    testRecorder: null,
    testChunks: [],
    testBlob: null,
    testUrl: null,
    testTimeout: null,
    micTestRecording: false
  }
};

const accountActions = document.querySelector("#account-actions");
const accountEmail = document.querySelector("#account-email");
const logoutButton = document.querySelector("#logout-button");

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

async function requestJson(url, options) {
  const isMultipart = options?.body instanceof FormData;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(!isMultipart ? { "Content-Type": "application/json" } : {}),
      ...(options && options.headers)
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function getStoredInterview() {
  try {
    const stored = sessionStorage.getItem(ACTIVE_INTERVIEW_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function storeInterviewProgress(phase = state.phase) {
  if (!state.interview?.id || state.interview.complete) {
    return;
  }
  try {
    sessionStorage.setItem(ACTIVE_INTERVIEW_KEY, JSON.stringify({
      id: state.interview.id,
      questionId: state.interview.questionId,
      phase
    }));
  } catch {
    state.error = "Interview progress could not be saved in this browser. Keep this page open.";
  }
}

function openRecordingStore() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("Recording recovery is not supported in this browser."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("clearview-interview-recordings", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("answers", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open temporary recording storage."));
  });
}

async function storePendingRecording() {
  if (!state.audioBlob || !state.interview || !state.submissionId) {
    return;
  }
  const db = await openRecordingStore();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("answers", "readwrite");
    const request = transaction.objectStore("answers").put({
      key: `${state.interview.id}:${state.interview.questionId}`,
      interviewId: state.interview.id,
      questionId: state.interview.questionId,
      submissionId: state.submissionId,
      createdAt: Date.now(),
      blob: state.audioBlob
    });
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error || new Error("Could not preserve the recorded answer."));
    transaction.onabort = () => reject(transaction.error || new Error("Could not preserve the recorded answer."));
  });
  db.close();
}

async function getPendingRecording(interviewId, questionId) {
  const db = await openRecordingStore();
  const entry = await new Promise((resolve, reject) => {
    const request = db.transaction("answers", "readonly")
      .objectStore("answers")
      .get(`${interviewId}:${questionId}`);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not recover the recorded answer."));
  });
  db.close();
  return entry;
}

async function deletePendingRecording(interviewId, questionId) {
  if (!("indexedDB" in window)) {
    return;
  }
  const db = await openRecordingStore();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("answers", "readwrite");
    const request = transaction.objectStore("answers").delete(`${interviewId}:${questionId}`);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error || new Error("Could not remove the temporary recording."));
    transaction.onabort = () => reject(transaction.error || new Error("Could not remove the temporary recording."));
  });
  db.close();
}

async function pruneExpiredRecordings() {
  if (!("indexedDB" in window)) {
    return;
  }
  const db = await openRecordingStore();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("answers", "readwrite");
    const request = transaction.objectStore("answers").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      if (
        !Number.isFinite(cursor.value.createdAt) ||
        Date.now() - cursor.value.createdAt > AUDIO_RETENTION_MS
      ) {
        cursor.delete();
      }
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not clear expired temporary recordings."));
    transaction.onabort = () => reject(transaction.error || new Error("Could not clear expired temporary recordings."));
  });
  db.close();
}

async function restoreInterview() {
  const stored = getStoredInterview();
  if (!stored || typeof stored.id !== "string") {
    return false;
  }

  try {
    await loadProctoringStatus();
    let interview;
    try {
      interview = await requestJson(`/api/interviews/${stored.id}/current-question`, { method: "GET" });
    } catch (error) {
      if (error.status !== 409) {
        throw error;
      }
      interview = await requestJson(`/api/interviews/${stored.id}/next-question`, { method: "GET" });
      if (stored.questionId) {
        try {
          await deletePendingRecording(stored.id, stored.questionId);
        } catch (error) {
          state.error = `The previous answer was saved, but its local recording could not be removed. ${error.message}`;
        }
      }
    }

    state.interview = interview;
    if (interview.complete) {
      sessionStorage.removeItem(ACTIVE_INTERVIEW_KEY);
      renderInterview();
      return true;
    }
    let pending;
    try {
      pending = await getPendingRecording(interview.id, interview.questionId);
    } catch (error) {
      state.phase = "recoveryError";
      state.recordingStatus = "Saved recording recovery failed";
      state.error = `Could not check for a saved answer. ${error.message}`;
      renderInterview();
      return true;
    }
    if (pending?.blob instanceof Blob && pending.blob.size > 0) {
      state.audioBlob = pending.blob;
      state.audioUrl = URL.createObjectURL(pending.blob);
      state.submissionId = pending.submissionId;
      state.phase = "recorded";
      state.recordingStatus = "Recorded answer recovered — ready to submit";
      state.error = "Your saved recording is ready. Submit it to continue.";
      storeInterviewProgress("recorded");
      void narrateCurrentQuestion(false);
    } else {
      const recordingInterrupted = stored.phase === "recording" ||
        stored.phase === "thinking" ||
        stored.phase === "recorded" ||
        stored.phase === "submitting";
      startThinkingPhase();
      if (recordingInterrupted) {
        state.error = stored.phase === "recorded" || stored.phase === "submitting"
          ? "A saved recording could not be recovered. The current question is unchanged; please record your answer again."
          : "Your previous recording was interrupted. The current question is unchanged; please record your answer again.";
      }
    }
    renderInterview();
    return true;
  } catch (error) {
    if (error.status === 404) {
      sessionStorage.removeItem(ACTIVE_INTERVIEW_KEY);
      return false;
    }
    state.error = `Could not resume your interview. ${error.message}`;
    return false;
  }
}

function renderAuth() {
  app.classList.remove("active-interview");
  app.replaceChildren();

  const layout = makeElement("section", "auth-layout");
  const card = makeElement("div", "setup-card auth-card");
  const isRegister = state.authMode === "register";
  card.append(
    makeElement("span", "card-kicker", "WELCOME TO CLEARVIEW"),
    makeElement("h1", "card-title auth-title", isRegister ? "Create your account" : "Welcome back"),
    makeElement(
      "p",
      "card-copy",
      isRegister
        ? "Create an account to start practicing for your next opportunity."
        : "Sign in to continue your interview practice."
    )
  );

  const form = makeElement("form", "setup-form");
  const emailLabel = makeElement("label", "field-label", "Email address");
  emailLabel.htmlFor = "auth-email";
  const emailInput = makeElement("input", "text-input");
  emailInput.id = "auth-email";
  emailInput.name = "email";
  emailInput.type = "email";
  emailInput.autocomplete = "email";
  emailInput.maxLength = 254;
  emailInput.required = true;
  emailInput.value = state.authEmail || "";

  const passwordLabel = makeElement(
    "label",
    "field-label",
    isRegister ? "Password (12–128 characters)" : "Password"
  );
  passwordLabel.htmlFor = "auth-password";
  const passwordInput = makeElement("input", "text-input");
  passwordInput.id = "auth-password";
  passwordInput.name = "password";
  passwordInput.type = "password";
  passwordInput.autocomplete = isRegister ? "new-password" : "current-password";
  passwordInput.minLength = isRegister ? 12 : 1;
  passwordInput.maxLength = 128;
  passwordInput.required = true;

  const error = makeElement("p", "form-error");
  error.setAttribute("role", "alert");
  if (state.authError) {
    error.textContent = state.authError;
  }

  const submit = makeElement(
    "button",
    "primary-button",
    state.authBusy ? "Please wait…" : isRegister ? "Create account" : "Sign in"
  );
  submit.type = "submit";
  submit.disabled = state.authBusy;

  const toggle = makeElement(
    "button",
    "auth-toggle",
    isRegister ? "Already have an account? Sign in" : "New to Clearview? Create an account"
  );
  toggle.type = "button";
  toggle.disabled = state.authBusy;
  toggle.addEventListener("click", () => {
    state.authMode = isRegister ? "login" : "register";
    state.authEmail = emailInput.value;
    state.authError = "";
    renderAuth();
  });

  form.append(emailLabel, emailInput, passwordLabel, passwordInput, error, submit);
  form.addEventListener("submit", authenticate);
  card.append(form, toggle);
  layout.append(card);
  app.append(layout);
  emailInput.focus();
}

async function authenticate(event) {
  event.preventDefault();
  if (state.authBusy) {
    return;
  }

  const formData = new FormData(event.currentTarget);
  state.authEmail = formData.get("email");
  state.authBusy = true;
  state.authError = "";
  renderAuth();

  try {
    const isRegister = state.authMode === "register";
    const result = await requestJson(`/api/auth/${isRegister ? "register" : "login"}`, {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password")
      })
    });
    state.user = result.user;
    state.authBusy = false;
    state.error = "";
    renderAccountActions();
    if (!(await restoreInterview())) {
      await initializeProctoringFlow();
    }
  } catch (error) {
    state.authBusy = false;
    state.authError = error.message;
    renderAuth();
  }
}

async function signOut() {
  logoutButton.disabled = true;
  try {
    stopQuestionNarration();
    await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
    if (state.interview && state.audioBlob) {
      try {
        await deletePendingRecording(state.interview.id, state.interview.questionId);
      } catch (error) {
        console.error("Could not remove the temporary recording on sign out.", error);
      }
    }
    stopProctoringCamera();
    stopMicrophoneTestStream();
    clearMicrophoneTestRecording();
    clearRecording();
    state.user = null;
    state.interview = null;
    state.analysisId = null;
    state.generatedQuestions = null;
    state.authMode = "login";
    state.authError = "";
    state.authEmail = "";
    state.proctoring.consented = false;
    state.proctoring.verified = false;
    state.proctoring.microphoneVerified = false;
    state.proctoring.stage = "camera";
    state.proctoring.cameraRecheck = false;
    state.proctoring.cameraStatus = "inactive";
    state.proctoring.microphoneStatus = "inactive";
    state.proctoring.requestBusy = false;
    state.proctoring.photoDataUrl = "";
    renderAccountActions();
    renderAuth();
  } catch (error) {
    state.error = error.message;
    renderSetup();
  } finally {
    logoutButton.disabled = false;
    sessionStorage.removeItem(ACTIVE_INTERVIEW_KEY);
  }
}

function renderAccountActions() {
  accountActions.hidden = !state.user;
  accountEmail.textContent = state.user ? state.user.email : "";
}

function registerProctoringBrowserEvents() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      recordProctoringEvent("warning_tab_hidden", { title: document.title });
    }
  });

  window.addEventListener("blur", () => {
    recordProctoringEvent("warning_window_blurred", { timestamp: Date.now() });
  });

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      recordProctoringEvent("warning_fullscreen_exited", { timestamp: Date.now() });
    }
  });
}

registerProctoringBrowserEvents();

async function loadProctoringStatus() {
  const status = await requestJson("/api/proctoring/session", { method: "GET" });
  state.proctoring.consented = Boolean(status.consented);
  state.proctoring.verified = Boolean(status.verified);
  state.proctoring.microphoneVerified = Boolean(status.microphoneVerified);
  state.proctoring.policyVersion = status.policyVersion || state.proctoring.policyVersion;
  return status;
}

async function initializeProctoringFlow() {
  try {
    const status = await loadProctoringStatus();
    state.proctoring.stage = !status.consented || !status.verified
      ? "camera"
      : status.microphoneVerified
        ? "resume"
        : "microphone";
    if (status.verified && !state.proctoring.videoReady) {
      state.proctoring.stage = "camera";
      state.proctoring.cameraRecheck = true;
    } else {
      state.proctoring.cameraRecheck = false;
    }
    if (state.proctoring.stage === "resume") {
      renderSetup();
    } else {
      renderVerification();
    }
  } catch (error) {
    state.error = `Could not load verification status. ${error.message}`;
    renderVerification();
  }
}

async function recordProctoringEvent(type, details = {}) {
  if (!state.user) {
    return;
  }
  try {
    await requestJson("/api/proctoring/events", {
      method: "POST",
      body: JSON.stringify({ type, details: { ...details, timestamp: Date.now() } })
    });
  } catch (error) {
    console.warn("Could not save proctoring event.", error);
  }
}

function stopProctoringCamera() {
  state.proctoring.cameraRequestGeneration += 1;
  if (state.proctoring.videoStream) {
    const stream = state.proctoring.videoStream;
    state.proctoring.videoStream = null;
    stream.getTracks().forEach((track) => track.stop());
  }
  state.proctoring.videoReady = false;
  state.proctoring.cameraStatus = "inactive";
}

function bindCameraPreview() {
  const video = document.querySelector("#verification-video") || document.querySelector(".proctoring-video");
  if (video && state.proctoring.videoStream) {
    video.srcObject = state.proctoring.videoStream;
    video.play().catch(() => {});
  }
}

function renderCurrentProctoringScreen() {
  if (state.interview && !state.interview.complete) {
    renderInterview();
  } else if (state.proctoring.stage === "resume" && state.generatedQuestions) {
    renderResumeReady();
  } else if (state.proctoring.stage === "resume") {
    renderSetup();
  } else {
    renderVerification();
  }
}

async function startProctoringCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    state.proctoring.cameraStatus = "unsupported";
    state.error = "This browser does not support webcam verification. Use a recent version of Chrome, Edge, or Firefox.";
    renderCurrentProctoringScreen();
    return;
  }

  state.error = "";
  stopProctoringCamera();
  state.proctoring.requestBusy = true;
  const generation = ++state.proctoring.cameraRequestGeneration;
  renderCurrentProctoringScreen();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    if (generation !== state.proctoring.cameraRequestGeneration || !state.user) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.proctoring.videoStream = stream;
    state.proctoring.videoReady = true;
    state.proctoring.cameraStatus = "connected";
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (state.proctoring.videoStream !== stream) {
          return;
        }
        state.proctoring.videoReady = false;
        state.proctoring.cameraStatus = "disconnected";
        state.error = "The camera disconnected. Reconnect it and retry camera verification.";
        recordProctoringEvent("warning_camera_disconnected");
        renderCurrentProctoringScreen();
      }, { once: true });
      track.addEventListener("mute", () => {
        if (state.proctoring.videoStream !== stream) {
          return;
        }
        state.proctoring.videoReady = false;
        state.proctoring.cameraStatus = "interrupted";
        state.error = "The camera stream was interrupted. Reconnect it to continue.";
        recordProctoringEvent("warning_camera_interrupted");
        renderCurrentProctoringScreen();
      });
      track.addEventListener("unmute", () => {
        if (state.proctoring.videoStream !== stream) {
          return;
        }
        state.proctoring.videoReady = true;
        state.proctoring.cameraStatus = "connected";
        state.error = "";
        renderCurrentProctoringScreen();
      });
    });
    state.proctoring.requestBusy = false;
    renderCurrentProctoringScreen();
    bindCameraPreview();
  } catch (error) {
    if (generation !== state.proctoring.cameraRequestGeneration || !state.user) {
      return;
    }
    state.proctoring.requestBusy = false;
    state.proctoring.cameraStatus = "denied";
    state.error = error.name === "NotAllowedError" || error.name === "SecurityError"
      ? "Camera access was denied. Allow camera access in your browser settings, then retry."
      : "Could not connect to the camera. Check that it is connected and not in use by another app.";
    renderCurrentProctoringScreen();
  }
}

async function handleVerificationConsent() {
  if (!state.user || state.proctoring.requestBusy) {
    return;
  }
  state.proctoring.requestBusy = true;
  state.error = "";
  renderCurrentProctoringScreen();
  try {
    const result = await requestJson("/api/proctoring/consent", {
      method: "POST",
      body: JSON.stringify({ consent: true, policyVersion: state.proctoring.policyVersion })
    });
    state.proctoring.consented = Boolean(result.consented);
    state.proctoring.policyVersion = result.policyVersion || state.proctoring.policyVersion;
    state.proctoring.requestBusy = false;
    await recordProctoringEvent("consent_granted", { policyVersion: state.proctoring.policyVersion });
    renderVerification();
  } catch (error) {
    state.proctoring.requestBusy = false;
    state.error = error.message;
    renderVerification();
  }
}

function captureCandidatePhoto() {
  const video = document.querySelector("#verification-video");
  if (!video || !state.proctoring.videoStream || !video.videoWidth || !video.videoHeight) {
    state.error = "The live camera preview is not ready. Wait for the preview and try again.";
    renderVerification();
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    state.error = "Your browser could not capture an image. Try another supported browser.";
    renderVerification();
    return;
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  state.proctoring.photoDataUrl = canvas.toDataURL("image/jpeg", 0.88);
  state.proctoring.previewVisible = true;
  state.error = "";
  renderVerification();
}

async function confirmVerification() {
  if (!state.proctoring.photoDataUrl || state.proctoring.requestBusy) {
    state.error = "Capture a verification photo before continuing.";
    renderVerification();
    return;
  }
  state.proctoring.requestBusy = true;
  state.error = "";
  renderVerification();
  try {
    const photoBlob = await (await fetch(state.proctoring.photoDataUrl)).blob();
    const formData = new FormData();
    formData.append("image", photoBlob, "verification.jpg");
    const result = await requestJson("/api/proctoring/verification", {
      method: "POST",
      body: formData
    });
    if (!result.verified) {
      throw new Error("The verification photo was not accepted. Please capture and submit it again.");
    }
    state.proctoring.verified = true;
    state.proctoring.stage = "microphone";
    state.proctoring.cameraRecheck = false;
    state.proctoring.photoDataUrl = "";
    state.proctoring.previewVisible = false;
    state.proctoring.requestBusy = false;
    await recordProctoringEvent("verification_confirmed", {
      verificationId: result.verificationId,
      size: result.size
    });
    renderVerification();
  } catch (error) {
    state.proctoring.requestBusy = false;
    state.error = `Photo upload failed. ${error.message}`;
    renderVerification();
  }
}

function stopMicrophoneLevelMonitor() {
  if (state.proctoring.meterFrame !== null) {
    window.cancelAnimationFrame(state.proctoring.meterFrame);
    state.proctoring.meterFrame = null;
  }
  if (state.proctoring.audioContext) {
    state.proctoring.audioContext.close().catch(() => {});
    state.proctoring.audioContext = null;
    state.proctoring.analyser = null;
  }
}

function stopMicrophoneTestStream() {
  state.proctoring.microphoneRequestGeneration += 1;
  const recorder = state.proctoring.testRecorder;
  state.proctoring.testRecorder = null;
  state.proctoring.micTestRecording = false;
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  if (state.proctoring.micStream) {
    const stream = state.proctoring.micStream;
    state.proctoring.micStream = null;
    stream.getTracks().forEach((track) => track.stop());
  }
  stopMicrophoneLevelMonitor();
}

function clearMicrophoneTestRecording() {
  if (state.proctoring.testUrl) {
    URL.revokeObjectURL(state.proctoring.testUrl);
  }
  state.proctoring.testUrl = null;
  state.proctoring.testBlob = null;
  state.proctoring.testChunks = [];
  state.proctoring.micTestRecording = false;
  if (state.proctoring.testTimeout) {
    window.clearTimeout(state.proctoring.testTimeout);
    state.proctoring.testTimeout = null;
  }
}

function updateMicrophoneLevel() {
  const analyser = state.proctoring.analyser;
  if (!analyser) {
    return;
  }
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }
  const level = Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 260));
  const meter = document.querySelector("#microphone-level");
  if (meter) {
    meter.style.width = `${level}%`;
  }
  state.proctoring.meterFrame = window.requestAnimationFrame(updateMicrophoneLevel);
}

async function requestMicrophoneTest() {
  if (state.proctoring.requestBusy || state.proctoring.micStream) {
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== "function") {
    state.error = "Microphone testing is not supported in this browser. Use a recent version of Chrome, Edge, or Firefox.";
    state.proctoring.microphoneStatus = "unsupported";
    renderVerification();
    return;
  }
  state.proctoring.requestBusy = true;
  state.error = "";
  renderVerification();
  const generation = ++state.proctoring.microphoneRequestGeneration;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== state.proctoring.microphoneRequestGeneration || !state.user) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Live microphone level testing is not supported by this browser.");
    }
    state.proctoring.micStream = stream;
    state.proctoring.audioContext = new AudioContextConstructor();
    state.proctoring.analyser = state.proctoring.audioContext.createAnalyser();
    state.proctoring.analyser.fftSize = 512;
    state.proctoring.audioContext.createMediaStreamSource(stream).connect(state.proctoring.analyser);
    state.proctoring.microphoneStatus = "connected";
    state.proctoring.requestBusy = false;
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (!state.proctoring.micStream || state.proctoring.testBlob) {
          return;
        }
        state.proctoring.microphoneStatus = "disconnected";
        state.error = "The microphone disconnected. Retry microphone verification.";
        stopMicrophoneTestStream();
        renderVerification();
      }, { once: true });
    });
    updateMicrophoneLevel();
    renderVerification();
  } catch (error) {
    if (generation !== state.proctoring.microphoneRequestGeneration || !state.user) {
      return;
    }
    state.proctoring.requestBusy = false;
    stopMicrophoneTestStream();
    state.proctoring.microphoneStatus = "denied";
    state.error = error.name === "NotAllowedError" || error.name === "SecurityError"
      ? "Microphone access was denied. Allow microphone access in your browser settings, then retry."
      : error.message || "Could not connect to the microphone. Check that it is connected and try again.";
    renderVerification();
  }
}

function finishMicrophoneTest() {
  const recorder = state.proctoring.testRecorder;
  if (recorder && recorder.state === "recording") {
    if (state.proctoring.testTimeout) {
      window.clearTimeout(state.proctoring.testTimeout);
      state.proctoring.testTimeout = null;
    }
    recorder.stop();
  }
}

function startMicrophoneTestRecording() {
  if (!state.proctoring.micStream || state.proctoring.micTestRecording || typeof MediaRecorder !== "function") {
    return;
  }
  clearMicrophoneTestRecording();
  try {
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = mimeType
      ? new MediaRecorder(state.proctoring.micStream, { mimeType })
      : new MediaRecorder(state.proctoring.micStream);
    state.proctoring.testRecorder = recorder;
    state.proctoring.testChunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) {
        state.proctoring.testChunks.push(event.data);
      }
    });
    recorder.addEventListener("stop", () => {
      if (state.proctoring.testRecorder !== recorder) {
        return;
      }
      state.proctoring.testBlob = new Blob(state.proctoring.testChunks, {
        type: recorder.mimeType || mimeType || "audio/webm"
      });
      state.proctoring.testChunks = [];
      state.proctoring.testRecorder = null;
      state.proctoring.micTestRecording = false;
      stopMicrophoneTestStream();
      if (state.proctoring.testBlob.size) {
        state.proctoring.testUrl = URL.createObjectURL(state.proctoring.testBlob);
        state.proctoring.microphoneStatus = "connected";
      } else {
        state.error = "The microphone test did not capture audio. Retry the test.";
      }
      renderVerification();
    }, { once: true });
    recorder.addEventListener("error", () => {
      if (state.proctoring.testRecorder !== recorder) {
        return;
      }
      state.proctoring.testRecorder = null;
      state.proctoring.micTestRecording = false;
      stopMicrophoneTestStream();
      state.proctoring.microphoneStatus = "inactive";
      state.error = "The microphone test recording failed. Retry microphone verification.";
      renderVerification();
    }, { once: true });
    recorder.start();
    state.proctoring.micTestRecording = true;
    state.proctoring.testTimeout = window.setTimeout(finishMicrophoneTest, 5000);
    state.error = "";
    renderVerification();
  } catch {
    state.proctoring.testRecorder = null;
    state.proctoring.micTestRecording = false;
    stopMicrophoneTestStream();
    state.proctoring.microphoneStatus = "inactive";
    state.error = "The test recording could not start. Retry microphone verification.";
    renderVerification();
  }
}

async function confirmMicrophoneVerification() {
  if (!state.proctoring.testBlob || state.proctoring.requestBusy) {
    state.error = "Complete a short microphone test recording before continuing.";
    renderVerification();
    return;
  }
  state.proctoring.requestBusy = true;
  state.error = "";
  renderVerification();
  try {
    const result = await requestJson("/api/proctoring/microphone-verification", {
      method: "POST",
      body: JSON.stringify({ verified: true })
    });
    if (!result.microphoneVerified) {
      throw new Error("The microphone verification was not accepted. Please retry.");
    }
    state.proctoring.microphoneVerified = true;
    state.proctoring.stage = "resume";
    state.proctoring.requestBusy = false;
    clearMicrophoneTestRecording();
    state.proctoring.microphoneStatus = "connected";
    await recordProctoringEvent("microphone_verification_confirmed");
    renderSetup();
  } catch (error) {
    state.proctoring.requestBusy = false;
    state.error = error.message;
    renderVerification();
  }
}

function renderVerificationProgress(step) {
  const progress = makeElement("div", "verification-progress");
  progress.setAttribute("aria-label", `Step ${step} of 3`);
  progress.append(
    makeElement("span", step === 1 ? "verification-step active" : "verification-step", "Step 1: Camera"),
    makeElement("span", step === 2 ? "verification-step active" : "verification-step", "Step 2: Microphone"),
    makeElement("span", step === 3 ? "verification-step active" : "verification-step", "Step 3: Resume")
  );
  return progress;
}

function renderVerification() {
  app.classList.remove("active-interview");
  app.replaceChildren();
  const layout = makeElement("section", "verification-layout");
  const card = makeElement("div", "setup-card verification-card");
  const cameraStage = state.proctoring.stage === "camera";
  card.append(
    renderVerificationProgress(cameraStage ? 1 : 2),
    makeElement("span", "card-kicker", cameraStage ? "CAMERA VERIFICATION" : "MICROPHONE VERIFICATION"),
    makeElement(
      "h1",
      "card-title",
      cameraStage ? "Confirm your camera setup" : "Test your microphone"
    ),
    makeElement(
      "p",
      "card-copy",
      cameraStage
        ? "Your photo is held in server memory for up to 24 hours or until restart for manual review only. It is never sent to AI or used for facial recognition. Your camera stays on during the interview."
        : "The microphone is used for answer recordings only during the interview. This short test is local and is not uploaded; its temporary recording is removed when you continue."
    )
  );

  const actions = makeElement("div", "analysis-actions");
  const previewWrap = makeElement("div", "verification-preview");

  if (cameraStage) {
    if (!state.proctoring.consented) {
      const consentBox = makeElement("div", "verification-consent");
      consentBox.append(
        makeElement(
          "p",
          "",
          "I consent to camera access and photo verification. I understand the camera stays on during my interview and my photo is held for up to 24 hours or until restart."
        )
      );
      const consent = makeElement(
        "button",
        "primary-button",
        state.proctoring.requestBusy ? "Saving consent…" : "I agree and continue"
      );
      consent.type = "button";
      consent.disabled = state.proctoring.requestBusy;
      consent.addEventListener("click", handleVerificationConsent);
      consentBox.append(consent);
      previewWrap.append(consentBox);
    } else {
      const status = makeElement(
        "p",
        `verification-status ${state.proctoring.cameraStatus === "connected" ? "connected" : ""}`,
        state.proctoring.cameraStatus === "connected" ? "Camera status: Connected" : "Camera status: Not connected"
      );
      previewWrap.append(status);
      if (state.proctoring.videoStream && state.proctoring.videoReady) {
        const video = makeElement("video", "verification-video");
        video.id = "verification-video";
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        previewWrap.append(video);
      }
      if (state.proctoring.cameraRecheck) {
        previewWrap.append(makeElement("p", "card-copy", "Your camera verification is already complete. Reconnect the live preview to continue after refreshing."));
        const reconnect = makeElement(
          "button",
          "primary-button",
          state.proctoring.requestBusy
            ? "Connecting camera…"
            : state.proctoring.videoReady
              ? "Continue"
              : state.proctoring.cameraStatus === "denied"
                ? "Retry camera permission"
                : "Reconnect camera"
        );
        reconnect.type = "button";
        reconnect.disabled = state.proctoring.requestBusy;
        reconnect.addEventListener("click", () => {
          if (!state.proctoring.videoReady) {
            startProctoringCamera();
            return;
          }
          state.proctoring.cameraRecheck = false;
          state.proctoring.stage = state.proctoring.microphoneVerified ? "resume" : "microphone";
          renderCurrentProctoringScreen();
        });
        actions.append(reconnect);
      } else {
        if (state.proctoring.photoDataUrl && state.proctoring.previewVisible) {
          const photo = makeElement("img", "verification-photo");
          photo.src = state.proctoring.photoDataUrl;
          photo.alt = "Candidate verification photo preview";
          previewWrap.append(photo);
        }
        const cameraButton = makeElement(
          "button",
          "primary-button",
          state.proctoring.requestBusy
            ? "Connecting camera…"
            : state.proctoring.videoReady
              ? state.proctoring.photoDataUrl ? "Retake Photo" : "Capture Photo"
              : state.proctoring.cameraStatus === "denied"
                ? "Retry camera permission"
                : "Enable camera preview"
        );
        cameraButton.type = "button";
        cameraButton.disabled = state.proctoring.requestBusy;
        cameraButton.addEventListener("click", () => {
          if (state.proctoring.videoReady) {
            captureCandidatePhoto();
          } else {
            startProctoringCamera();
          }
        });
        actions.append(cameraButton);
        if (state.proctoring.photoDataUrl) {
          const confirm = makeElement(
            "button",
            "secondary-button",
            state.proctoring.requestBusy
              ? "Uploading photo…"
              : state.error.startsWith("Photo upload failed.")
                ? "Retry Photo Upload"
                : "Confirm Photo & Continue"
          );
          confirm.type = "button";
          confirm.disabled = state.proctoring.requestBusy;
          confirm.addEventListener("click", confirmVerification);
          actions.append(confirm);
        }
      }
    }
  } else {
    previewWrap.append(
      makeElement(
        "p",
        `verification-status ${state.proctoring.microphoneStatus === "connected" ? "connected" : ""}`,
        state.proctoring.microphoneStatus === "connected"
          ? "Microphone status: Connected"
          : "Microphone status: Not connected"
      )
    );
    if (state.proctoring.micStream) {
      const meter = makeElement("div", "microphone-meter");
      meter.setAttribute("role", "meter");
      meter.setAttribute("aria-label", "Live microphone input level");
      const level = makeElement("span", "microphone-level");
      level.id = "microphone-level";
      meter.append(level);
      previewWrap.append(meter);
    }
    if (state.proctoring.testUrl) {
      const playback = document.createElement("audio");
      playback.className = "recording-playback";
      playback.controls = true;
      playback.src = state.proctoring.testUrl;
      playback.setAttribute("aria-label", "Play microphone test recording");
      previewWrap.append(playback);
    }
    if (!state.proctoring.micStream && !state.proctoring.testBlob) {
      const enableMic = makeElement(
        "button",
        "primary-button",
        state.proctoring.requestBusy
          ? "Requesting microphone…"
          : state.proctoring.microphoneStatus === "denied" || state.proctoring.microphoneStatus === "disconnected"
            ? "Retry microphone permission"
            : "Enable microphone & test"
      );
      enableMic.type = "button";
      enableMic.disabled = state.proctoring.requestBusy;
      enableMic.addEventListener("click", requestMicrophoneTest);
      actions.append(enableMic);
    } else if (state.proctoring.micStream && !state.proctoring.micTestRecording) {
      const record = makeElement("button", "primary-button", "Start short test recording");
      record.type = "button";
      record.addEventListener("click", startMicrophoneTestRecording);
      actions.append(record);
    } else if (state.proctoring.micTestRecording) {
      const stop = makeElement("button", "secondary-button", "Stop test recording");
      stop.type = "button";
      stop.addEventListener("click", finishMicrophoneTest);
      actions.append(stop);
    }
    if (state.proctoring.testBlob) {
      const confirm = makeElement(
        "button",
        "primary-button",
        state.proctoring.requestBusy
          ? "Saving verification…"
          : state.error
            ? "Retry Microphone Verification"
            : "Confirm Microphone & Continue"
      );
      confirm.type = "button";
      confirm.disabled = state.proctoring.requestBusy;
      confirm.addEventListener("click", confirmMicrophoneVerification);
      actions.append(confirm);
    }
  }

  if (state.error) {
    const error = makeElement("p", "form-error", state.error);
    error.setAttribute("role", "alert");
    card.append(error);
  }
  card.append(previewWrap, actions);
  layout.append(card);
  app.append(layout);
  bindCameraPreview();
}

function renderSetup() {
  if (!state.proctoring.verified || !state.proctoring.microphoneVerified) {
    state.proctoring.stage = state.proctoring.verified ? "microphone" : "camera";
    renderVerification();
    return;
  }
  state.proctoring.stage = "resume";
  app.classList.remove("active-interview");
  app.replaceChildren();

  const layout = makeElement("section", "setup-layout");
  const intro = makeElement("div", "intro-panel");
  intro.append(
    makeElement("span", "eyebrow", "YOUR NEXT OPPORTUNITY STARTS HERE"),
    makeElement("h1", "hero-title", "Show up as your most confident self."),
    makeElement(
      "p",
      "hero-copy",
      "A little practice can make a big difference. Upload your resume to uncover your experience and build personalized technical questions."
    )
  );

  const promiseList = makeElement("ul", "promise-list");
  [
    ["01", "Resume-guided questions", "Practice questions shaped by experience in your resume."],
    ["02", "Five minutes per question", "Think through each answer before submitting it."],
    ["03", "Helpful reflection", "Get simple pointers to strengthen your next answer."]
  ].forEach(([number, title, description]) => {
    const item = makeElement("li", "promise-item");
    item.append(
      makeElement("span", "promise-number", number),
      makeElement("span", "promise-text")
    );
    item.lastElementChild.append(
      makeElement("strong", "", title),
      makeElement("span", "", description)
    );
    promiseList.append(item);
  });
  intro.append(promiseList);

  const card = makeElement("div", "setup-card");
  card.append(
    renderVerificationProgress(3),
    makeElement("span", "card-kicker", "LET’S GET YOU READY"),
    makeElement("h2", "card-title", "Upload your resume"),
    makeElement("p", "card-copy", "We’ll analyze your skills and projects, then create interview questions grounded in your resume. PDF, DOCX, TXT, or Markdown, up to 5 MB.")
  );

  const form = makeElement("form", "setup-form");
  const resumeLabel = makeElement("label", "field-label", "Choose your resume");
  resumeLabel.htmlFor = "resume-file";
  const resumeInput = makeElement("input", "text-input resume-input");
  resumeInput.id = "resume-file";
  resumeInput.name = "resume";
  resumeInput.type = "file";
  resumeInput.accept = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";
  resumeInput.required = true;
  resumeInput.disabled = state.busy;

  const error = makeElement("p", "form-error");
  error.setAttribute("role", "alert");
  if (state.error) {
    error.textContent = state.error;
  }

  const submit = makeElement("button", "primary-button", state.busy ? "Analyzing your resume…" : "Analyze resume");
  submit.type = "submit";
  submit.disabled = state.busy;
  submit.append(makeElement("span", "button-arrow", "→"));

  form.append(resumeLabel, resumeInput, error, submit);
  form.addEventListener("submit", analyzeResume);
  card.append(form, makeElement("p", "privacy-note", "The resume is sent to the configured AI provider for analysis and isn’t saved by this app."));

  layout.append(intro, card);
  app.append(layout);
  resumeInput.focus();
}

async function analyzeResume(event) {
  event.preventDefault();
  if (!state.proctoring.verified || !state.proctoring.microphoneVerified) {
    state.error = "Complete camera and microphone verification before uploading a resume.";
    state.proctoring.stage = state.proctoring.verified ? "microphone" : "camera";
    renderVerification();
    return;
  }
  if (state.busy) {
    return;
  }

  const formData = new FormData(event.currentTarget);
  const resume = formData.get("resume");
  if (!(resume instanceof File) || !resume.size) {
    state.error = "Choose a resume file to continue.";
    renderSetup();
    return;
  }
  if (resume.size > 5 * 1024 * 1024) {
    state.error = "Choose a resume file no larger than 5 MB.";
    renderSetup();
    return;
  }

  state.busy = true;
  state.error = "";
  renderSetup();

  try {
    const bytes = new Uint8Array(await resume.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }

    const result = await requestJson("/api/resume/analyze", {
      method: "POST",
      body: JSON.stringify({ filename: resume.name, contentBase64: btoa(binary) })
    });
    state.analysisId = result.analysisId;
    state.generatedQuestions = null;
    state.busy = false;
    renderResumeReady();
  } catch (error) {
    state.busy = false;
    state.error = error.message;
    renderSetup();
  }
}

function renderResumeReady() {
  app.classList.remove("active-interview");
  app.replaceChildren();
  const page = makeElement("section", "resume-ready-page");
  page.append(
    makeElement("span", "eyebrow", "RESUME READY"),
    makeElement("h1", "interview-title", "Your resume is ready."),
    makeElement("p", "resume-status", "Resume uploaded successfully."),
    makeElement("p", "resume-status", "Resume analyzed successfully.")
  );
  const questionPanel = makeElement("section", "question-generation-panel");
  questionPanel.append(
    makeElement("span", "card-kicker", "PERSONALIZED PRACTICE"),
    makeElement("h2", "card-title", state.generatedQuestions ? "Your interview questions" : "Ready to practice?")
  );
  if (state.busy) {
    const loading = makeElement("div", "question-loading");
    loading.setAttribute("role", "status");
    loading.append(
      makeElement("span", "loading-spinner"),
      makeElement("span", "", "Creating personalized questions…")
    );
    questionPanel.append(loading);
  }
  if (state.generatedQuestions) {
    questionPanel.append(makeElement("p", "resume-status", "10 personalized questions are ready."));
  }
  if (state.error) {
    const error = makeElement("p", "form-error analysis-error", state.error);
    error.setAttribute("role", "alert");
    questionPanel.append(error);
  }
  const actions = makeElement("div", "analysis-actions");
  if (!state.proctoring.videoReady || !state.proctoring.videoStream) {
    const cameraStatus = makeElement(
      "p",
      "verification-status",
      "Camera not connected. Reconnect it before starting your interview."
    );
    cameraStatus.setAttribute("role", "status");
    questionPanel.append(cameraStatus);
    const reconnect = makeElement(
      "button",
      "secondary-button",
      state.proctoring.requestBusy ? "Connecting camera…" : "Reconnect camera"
    );
    reconnect.type = "button";
    reconnect.disabled = state.proctoring.requestBusy;
    reconnect.addEventListener("click", startProctoringCamera);
    actions.append(reconnect);
  }
  if (!state.generatedQuestions) {
    const generate = makeElement(
      "button",
      "primary-button",
      state.busy ? "Generating questions…" : "Generate 10 Interview Questions"
    );
    generate.type = "button";
    generate.disabled = state.busy;
    generate.addEventListener("click", generateInterviewQuestions);
    actions.append(generate);
  }
  if (state.generatedQuestions) {
    const start = makeElement("button", "primary-button", state.busy ? "Preparing interview…" : "Start interview");
    start.type = "button";
    start.disabled = state.busy || !state.proctoring.videoReady || !state.proctoring.videoStream;
    start.addEventListener("click", startInterview);
    actions.append(start);
  }
  const newResume = makeElement("button", "auth-toggle", "Upload a different resume");
  newResume.type = "button";
  newResume.disabled = state.busy;
  newResume.addEventListener("click", () => {
    state.analysisId = null;
    state.generatedQuestions = null;
    state.error = "";
    renderSetup();
  });
  actions.append(newResume);
  questionPanel.append(actions);
  page.append(questionPanel);
  app.append(page);
}

async function generateInterviewQuestions() {
  if (state.busy) {
    return;
  }
  state.busy = true;
  state.error = "";
  renderResumeReady();
  try {
    const result = await requestJson("/api/interviews/generate-questions", {
      method: "POST",
      body: JSON.stringify({ analysisId: state.analysisId })
    });
    state.generatedQuestions = result.generated === true && result.questionCount === 10;
    state.busy = false;
    renderResumeReady();
  } catch (error) {
    state.busy = false;
    state.error = error.message;
    renderResumeReady();
  }
}

async function startInterview() {
  if (!state.proctoring.verified || !state.proctoring.microphoneVerified) {
    state.proctoring.stage = state.proctoring.verified ? "microphone" : "camera";
    renderVerification();
    return;
  }
  if (!state.proctoring.videoReady || !state.proctoring.videoStream) {
    state.error = "Reconnect your camera before starting the interview.";
    renderResumeReady();
    return;
  }
  if (state.busy) {
    return;
  }
  state.busy = true;
  state.error = "";
  renderResumeReady();
  try {
    const result = await requestJson("/api/interviews", {
      method: "POST",
      body: JSON.stringify({ analysisId: state.analysisId })
    });
    state.interview = result.interview;
    state.answerSubmitted = false;
    state.activeQuestionId = null;
    storeInterviewProgress("thinking");
    startThinkingPhase();
    state.busy = false;
    renderInterview();
  } catch (error) {
    state.busy = false;
    state.error = error.message;
    renderResumeReady();
  }
}

function formatRecordingTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function stopMediaTracks() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
  state.proctoring.microphoneStatus = state.proctoring.microphoneVerified ? "connected" : "inactive";
}

function clearRecordedAnswer() {
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
  }
  state.audioUrl = null;
  state.audioBlob = null;
  state.audioChunks = [];
  state.recordingSeconds = 0;
  state.recordingStatus = "Waiting to record";
  state.submissionId = null;
}

function createSubmissionId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function clearRecording() {
  stopQuestionNarration();
  state.recordingGeneration += 1;
  state.requestingMicrophone = false;
  clearInterviewTimer();
  if (state.recorder && state.recorder.state !== "inactive") {
    state.recorder.onstop = null;
    state.recorder.stop();
  }
  state.recorder = null;
  stopMediaTracks();
  clearRecordedAnswer();
  state.phase = "idle";
  state.phaseDeadline = null;
  state.autoSubmitOnStop = false;
}

function clearInterviewTimer() {
  if (state.timerInterval) {
    window.clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  state.phaseDeadline = null;
}

function savePhase(phase) {
  state.phase = phase;
  storeInterviewProgress(phase);
}

function tickPhaseTimer() {
  if (!state.phaseDeadline) {
    return;
  }
  const remainingMs = InterviewTiming.remainingMilliseconds(state.phaseDeadline);
  state.recordingSeconds = InterviewTiming.remainingSeconds(state.phaseDeadline);
  const timer = document.querySelector(".recording-time");
  if (timer) {
    timer.textContent = formatRecordingTime(state.recordingSeconds);
  }
  if (remainingMs > 0) {
    return;
  }

  clearInterviewTimer();
  if (state.phase === "thinking") {
    state.recordingStatus = "Starting microphone";
    savePhase("requestingMicrophone");
    renderInterview();
    startRecording();
  } else if (state.phase === "recording") {
    finalizeRecording(true);
  }
}

function startPhaseTimer(phase, durationMs) {
  clearInterviewTimer();
  state.phaseDeadline = InterviewTiming.deadlineAfter(durationMs);
  state.recordingSeconds = Math.ceil(durationMs / 1000);
  savePhase(phase);
  state.timerInterval = window.setInterval(tickPhaseTimer, TIMER_TICK_MS);
  renderInterview();
}

function stopQuestionNarration() {
  state.questionNarrationGeneration += 1;
  state.questionNarrationPending = false;
  state.questionNarrationReturnToThinking = false;
  if (typeof QuestionNarration !== "undefined") {
    QuestionNarration.cancel();
  }
}

function startThinkingCountdown() {
  if (!state.interview || state.interview.complete) {
    return;
  }
  state.recordingStatus = "Prepare your answer";
  state.answerSubmitted = false;
  state.autoSubmitOnStop = false;
  startPhaseTimer("thinking", THINKING_PHASE_MS);
}

async function narrateCurrentQuestion(startPreparationAfter = true) {
  if (!state.interview || state.interview.complete || !state.interview.currentQuestion) {
    return;
  }

  const generation = ++state.questionNarrationGeneration;
  if (typeof QuestionNarration !== "undefined") {
    QuestionNarration.cancel();
  }
  clearInterviewTimer();
  state.questionNarrationPending = true;
  state.questionNarrationReturnToThinking = startPreparationAfter;
  state.activeQuestionId = state.interview.questionId;
  if (startPreparationAfter) {
    state.error = "";
    state.phase = "narrating";
    state.recordingSeconds = 0;
    state.recordingStatus = "Reading question aloud";
    storeInterviewProgress("narrating");
  }
  renderInterview();

  if (state.questionAudioMuted || typeof QuestionNarration === "undefined" || !QuestionNarration.isSupported()) {
    state.questionNarrationUnavailable = !state.questionAudioMuted;
    finishQuestionNarration(generation, false, startPreparationAfter);
    return;
  }

  const spoken = await QuestionNarration.speakQuestion(state.interview.currentQuestion);
  finishQuestionNarration(generation, spoken, startPreparationAfter);
}

function finishQuestionNarration(generation, spoken, startPreparationAfter) {
  if (generation !== state.questionNarrationGeneration) {
    return;
  }
  state.questionNarrationPending = false;
  state.questionNarrationReturnToThinking = false;
  if (!spoken && !state.questionAudioMuted) {
    state.questionNarrationUnavailable = true;
  }
  if (startPreparationAfter && state.phase === "narrating") {
    state.recordingStatus = spoken
      ? "Question finished. Prepare your answer"
      : state.questionAudioMuted
        ? "Question audio muted"
        : "Question audio unavailable; continuing silently";
    startThinkingCountdown();
    return;
  }
  renderInterview();
}

function startThinkingPhase() {
  if (!state.interview || state.interview.complete) {
    return;
  }
  state.activeQuestionId = state.interview.questionId;
  state.error = "";
  state.answerSubmitted = false;
  state.autoSubmitOnStop = false;
  void narrateCurrentQuestion(true);
}

function replayCurrentQuestion() {
  if (
    state.questionAudioMuted ||
    !state.interview ||
    state.interview.complete ||
    !["narrating", "thinking", "recorded", "microphoneError"].includes(state.phase)
  ) {
    return;
  }
  void narrateCurrentQuestion(["narrating", "thinking"].includes(state.phase));
}

function toggleQuestionAudio() {
  state.questionAudioMuted = !state.questionAudioMuted;
  if (state.questionAudioMuted && state.questionNarrationPending) {
    state.questionNarrationGeneration += 1;
    if (typeof QuestionNarration !== "undefined") {
      QuestionNarration.cancel();
    }
    state.questionNarrationPending = false;
    const shouldStartThinking = state.questionNarrationReturnToThinking;
    state.questionNarrationReturnToThinking = false;
    if (shouldStartThinking) {
      state.recordingStatus = "Question audio muted";
      startThinkingCountdown();
      return;
    }
  }
  renderInterview();
}

function finalizeRecording(submitAfterStop) {
  if (state.recorder?.state !== "recording" || state.autoSubmitOnStop) {
    return;
  }
  state.autoSubmitOnStop = submitAfterStop;
  clearInterviewTimer();
  state.recordingStatus = submitAfterStop ? "Finalizing answer" : "Recording stopped";
  if (submitAfterStop) {
    savePhase("submitting");
  }
  state.recorder.stop();
  renderInterview();
}

async function startRecording() {
  if (state.busy || state.answerSubmitted || state.recorder || state.requestingMicrophone || state.audioBlob) {
    return;
  }
  state.error = "";
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== "function") {
    state.phase = "microphoneError";
    state.error = "Audio recording is not supported in this browser. Use a recent version of Chrome, Edge, or Firefox.";
    state.recordingStatus = "Microphone unavailable";
    renderInterview();
    return;
  }

  state.requestingMicrophone = true;
  const generation = ++state.recordingGeneration;
  state.recordingStatus = "Waiting for microphone permission";
  savePhase("requestingMicrophone");
  renderInterview();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== state.recordingGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.mediaStream = stream;
    state.proctoring.microphoneStatus = "active";
    state.requestingMicrophone = false;
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (state.recorder?.state === "recording") {
          state.error = "The microphone disconnected during recording. Retry the answer recording.";
          state.proctoring.microphoneStatus = "disconnected";
          finalizeRecording(false);
          renderInterview();
        }
      }, { once: true });
    });
    const supportedTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus"
    ];
    const mimeType = supportedTypes.find((type) => MediaRecorder.isTypeSupported(type));
    state.recorder = mimeType
      ? new MediaRecorder(state.mediaStream, { mimeType })
      : new MediaRecorder(state.mediaStream);
    state.audioChunks = [];
    state.recordingStartedAt = Date.now();
    state.recordingStatus = "Recording in progress";
    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) {
        state.audioChunks.push(event.data);
      }
    });
    state.recorder.addEventListener("error", () => {
      state.error = "The audio recording failed. Check your microphone and try again.";
      stopMediaTracks();
      state.recorder = null;
      state.recordingStatus = "Recording failed";
      clearInterviewTimer();
      state.phase = "microphoneError";
      storeInterviewProgress("microphoneError");
      renderInterview();
    });
    state.recorder.addEventListener("stop", () => {
      const audioType = state.recorder?.mimeType || mimeType || "audio/webm";
      state.audioBlob = new Blob(state.audioChunks, { type: audioType });
      state.audioChunks = [];
      stopMediaTracks();
      state.recorder = null;
      state.recordingStartedAt = null;
      if (!state.audioBlob.size || state.audioBlob.size > MAX_AUDIO_BYTES) {
        clearRecordedAnswer();
        state.error = "The recording is empty or larger than 10 MB. Record a shorter answer.";
        state.recordingStatus = "Recording failed";
        state.phase = "microphoneError";
      } else {
        state.audioUrl = URL.createObjectURL(state.audioBlob);
        state.recordingStatus = state.autoSubmitOnStop
          ? "Uploading and transcribing answer"
          : "Recording completed";
        state.phase = state.autoSubmitOnStop ? "submitting" : "recorded";
        state.submissionId = createSubmissionId();
        storeInterviewProgress(state.phase);
      }
      renderInterview();
      if (state.audioBlob && state.autoSubmitOnStop) {
        submitAnswer();
      } else if (state.audioBlob) {
        storePendingRecording().catch((error) => {
          state.error = `The recording is ready, but could not be saved for recovery after a refresh. ${error.message}`;
          renderInterview();
        });
      }
    });
    state.recorder.start(250);
    state.recordingStatus = "Recording in progress";
    startPhaseTimer("recording", MAX_RECORDING_MS);
  } catch (error) {
    if (generation !== state.recordingGeneration) {
      return;
    }
    stopMediaTracks();
    state.recorder = null;
    state.requestingMicrophone = false;
    state.error = error.name === "NotAllowedError" || error.name === "SecurityError"
      ? "Microphone access was denied. Allow microphone access in your browser settings, then try again."
      : "Could not start the microphone. Check that it is connected and not being used by another app.";
    state.recordingStatus = "Microphone permission needed";
    state.phase = "microphoneError";
    storeInterviewProgress("microphoneError");
    renderInterview();
  }
}

function renderInterview() {
  app.classList.add("active-interview");
  app.replaceChildren();
  const interview = state.interview;
  const page = makeElement("section", "interview-layout");
  const heading = makeElement("div", "interview-heading");
  const headingCopy = makeElement("div");
  headingCopy.append(
    makeElement("span", "eyebrow", "VOICE INTERVIEW"),
    makeElement("h1", "interview-title", interview.complete ? "That’s a wrap." : "Your interviewer is ready.")
  );
  heading.append(headingCopy);

  if (interview.complete) {
    stopQuestionNarration();
    stopProctoringCamera();
    stopMicrophoneTestStream();
    clearMicrophoneTestRecording();
    page.append(heading, renderSummary(interview.summary));
    app.append(page);
    return;
  }

  const progress = makeElement("section", "voice-progress-card");
  const progressLabel = makeElement(
    "div",
    "voice-progress-label",
    `Question ${interview.questionNumber} of ${interview.totalQuestions}`
  );
  const progressTrack = makeElement("div", "progress-track");
  const progressFill = makeElement("span", "progress-fill");
  progressFill.style.width = `${Math.round((interview.questionNumber / interview.totalQuestions) * 100)}%`;
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-valuemin", "1");
  progressTrack.setAttribute("aria-valuemax", String(interview.totalQuestions));
  progressTrack.setAttribute("aria-valuenow", String(interview.questionNumber));
  progressTrack.append(progressFill);
  progress.append(progressLabel, progressTrack);

  const proctoringWidget = makeElement("aside", "proctoring-widget");
  const previewWrap = makeElement("div", "proctoring-preview");
  const previewVideo = makeElement("video", "proctoring-video");
  previewVideo.autoplay = true;
  previewVideo.playsInline = true;
  previewVideo.muted = true;
  if (state.proctoring.videoStream) {
    previewVideo.srcObject = state.proctoring.videoStream;
    previewVideo.play().catch(() => {});
  }
  const cameraBadge = makeElement(
    "span",
    "proctoring-status",
    state.proctoring.videoReady ? "Camera connected" : "Camera disconnected"
  );
  const micBadge = makeElement("span", "proctoring-status", state.proctoring.microphoneStatus === "active" ? "Mic active" : "Mic idle");
  const sessionBadge = makeElement("span", "proctoring-status", "Interview active");
  previewWrap.append(previewVideo);
  proctoringWidget.append(
    makeElement("div", "proctoring-heading", "Proctoring"),
    previewWrap,
    makeElement("div", "proctoring-badges", ""),
    cameraBadge,
    micBadge,
    sessionBadge
  );
  const badgeRow = proctoringWidget.querySelector(".proctoring-badges");
  badgeRow.append(cameraBadge, micBadge, sessionBadge);
  if (!state.proctoring.videoReady) {
    const reconnectCamera = makeElement(
      "button",
      "secondary-button proctoring-reconnect",
      state.proctoring.requestBusy ? "Connecting camera…" : "Reconnect camera"
    );
    reconnectCamera.type = "button";
    reconnectCamera.disabled = state.proctoring.requestBusy;
    reconnectCamera.addEventListener("click", startProctoringCamera);
    proctoringWidget.append(reconnectCamera);
  }

  const questionCard = makeElement("section", "voice-question-card");
  questionCard.setAttribute("aria-label", `Interview question ${interview.questionNumber}`);
  const interviewer = makeElement("div", "voice-interviewer");
  interviewer.append(
    makeElement("span", "interviewer-avatar", "✳"),
    makeElement("span", "", "Your interviewer")
  );
  questionCard.append(
    interviewer,
    makeElement("p", "voice-question", interview.currentQuestion || "Your next question is loading.")
  );
  const narrationControls = makeElement("div", "question-audio-controls");
  const replayQuestion = makeElement("button", "secondary-button", "Replay Question");
  replayQuestion.type = "button";
  replayQuestion.disabled = state.questionAudioMuted ||
    !QuestionNarration.isSupported() ||
    !["narrating", "thinking", "recorded", "microphoneError"].includes(state.phase);
  replayQuestion.addEventListener("click", replayCurrentQuestion);
  const muteQuestionAudio = makeElement(
    "button",
    "secondary-button",
    state.questionAudioMuted ? "Unmute Question Audio" : "Mute Question Audio"
  );
  muteQuestionAudio.type = "button";
  muteQuestionAudio.disabled = typeof QuestionNarration === "undefined" || !QuestionNarration.isSupported();
  muteQuestionAudio.addEventListener("click", toggleQuestionAudio);
  narrationControls.append(replayQuestion, muteQuestionAudio);
  if (state.questionNarrationUnavailable) {
    narrationControls.append(makeElement("span", "question-audio-note", "English voice narration is unavailable in this browser; the interview will continue silently."));
  }
  questionCard.append(narrationControls);

  const recorderPanel = makeElement("section", "voice-recorder-panel");
  const recorderHeader = makeElement("div", "recording-header");
  const statusIndicator = makeElement("span", "recording-indicator");
  if (state.phase === "recording") {
    statusIndicator.classList.add("recording-indicator-live");
  } else if (state.phase === "thinking") {
    statusIndicator.classList.add("recording-indicator-thinking");
  } else if (state.phase === "submitting" || state.phase === "loadingNext") {
    statusIndicator.classList.add("recording-indicator-working");
  }
  const statusText = makeElement("span", "recording-status", state.recordingStatus);
  statusText.setAttribute("aria-live", "polite");
  recorderHeader.append(statusIndicator, statusText);
  const timer = makeElement("span", "recording-time", formatRecordingTime(state.recordingSeconds));
  timer.setAttribute(
    "aria-label",
    state.phase === "narrating"
      ? "Question narration"
      : state.phase === "thinking"
        ? "Preparation countdown"
        : "Recording time remaining"
  );
  const timerMessage = makeElement(
    "p",
    "timer-message",
    state.phase === "narrating"
      ? "Listening to the question…"
      : state.phase === "thinking"
        ? "Prepare your answer"
      : state.phase === "recording"
        ? "Recording your answer"
        : state.phase === "loadingNext"
          ? "Loading next question…"
          : state.phase === "submitting" || state.busy
            ? "Saving and transcribing your answer…"
            : state.phase === "recorded"
              ? "Your recording is ready to submit"
              : ""
  );

  const controls = makeElement("div", "recording-controls");
  if (state.phase === "recording" && !state.busy) {
    const submit = makeElement("button", "primary-button", "Submit Answer");
    submit.type = "button";
    submit.addEventListener("click", () => finalizeRecording(true));
    controls.append(submit);
  } else if (state.audioBlob) {
    const playback = document.createElement("audio");
    playback.className = "recording-playback";
    playback.controls = true;
    playback.preload = "metadata";
    playback.src = state.audioUrl;
    playback.setAttribute("aria-label", "Play your recorded answer");
    const playButton = makeElement("button", "secondary-button", "Play Recording");
    playButton.type = "button";
    playButton.addEventListener("click", async () => {
      try {
        await playback.play();
      } catch {
        state.error = "The recording could not be played in this browser.";
        renderInterview();
      }
    });
    const rerecord = makeElement("button", "secondary-button", "Re-record Answer");
    rerecord.type = "button";
    rerecord.disabled = state.busy;
    rerecord.addEventListener("click", async () => {
      state.busy = true;
      state.error = "";
      try {
        await deletePendingRecording(state.interview.id, state.interview.questionId);
        clearRecordedAnswer();
        state.busy = false;
        startThinkingPhase();
      } catch (error) {
        state.busy = false;
        state.error = `The previous temporary recording could not be removed, so a new answer cannot be started yet. ${error.message}`;
        renderInterview();
      }
    });
    const submit = makeElement(
      "button",
      "primary-button",
      state.busy ? "Submitting answer…" : "Submit Answer"
    );
    submit.type = "button";
    submit.disabled = state.busy || state.phase === "thinking" || state.phase === "recording";
    submit.addEventListener("click", submitAnswer);
    controls.append(playButton, playback, rerecord, submit);
  } else if (state.phase === "microphoneError") {
    const retry = makeElement("button", "primary-button recording-start", "Try microphone again");
    retry.type = "button";
    retry.disabled = state.busy || state.requestingMicrophone;
    retry.addEventListener("click", startRecording);
    controls.append(retry);
  } else if (state.phase === "recoveryError") {
    const retry = makeElement("button", "primary-button", "Retry answer recovery");
    retry.type = "button";
    retry.addEventListener("click", async () => {
      state.error = "";
      if (!(await restoreInterview())) {
        state.error = "The interview could not be resumed. Check your connection and try again.";
        renderInterview();
      }
    });
    controls.append(retry);
  }
  recorderPanel.append(recorderHeader, timer, timerMessage, controls);

  if (state.error) {
    const error = makeElement("p", "form-error interview-error", state.error);
    error.setAttribute("role", "alert");
    recorderPanel.append(error);
  }
  const interviewMainGrid = makeElement("div", "interview-main-grid");
  interviewMainGrid.append(questionCard, proctoringWidget);
  page.append(heading, progress, interviewMainGrid, recorderPanel);
  app.append(page);
}

function renderSummary(summary) {
  const panel = makeElement("section", "summary-panel");
  panel.setAttribute("aria-live", "polite");
  panel.append(
    makeElement("span", "summary-eyebrow", "YOUR PRACTICE RECAP"),
    makeElement("h2", "summary-title", "Every practice round is progress."),
    makeElement("p", "summary-copy", summary.overallFeedback)
  );
  const score = makeElement("div", "summary-score");
  score.append(
    makeElement("strong", "score-number", `${summary.averageScore}`),
    makeElement("span", "score-caption", "practice detail score / 5")
  );
  panel.append(
    score,
    makeElement("p", "scoring-note", summary.scoringNote)
  );
  const restart = makeElement("button", "secondary-button", "Start another practice interview");
  restart.type = "button";
  restart.addEventListener("click", () => {
    clearRecording();
    sessionStorage.removeItem(ACTIVE_INTERVIEW_KEY);
    state.interview = null;
    state.generatedQuestions = null;
    state.error = "";
    state.answerSubmitted = false;
    renderResumeReady();
  });
  panel.append(restart);
  return panel;
}

async function submitAnswer() {
  if (state.busy || state.answerSubmitted || !state.audioBlob) {
    return;
  }

  clearInterviewTimer();
  const formData = new FormData();
  const mimeType = state.audioBlob.type || "audio/webm";
  const extension = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
  formData.append("questionId", String(state.interview.questionId));
  state.submissionId ||= createSubmissionId();
  formData.append("submissionId", state.submissionId);
  formData.append("audio", state.audioBlob, `answer.${extension}`);
  state.busy = true;
  state.error = "";
  state.recordingStatus = "Uploading and transcribing answer";
  state.phase = "submitting";
  storeInterviewProgress("submitting");
  renderInterview();

  try {
    try {
      await storePendingRecording();
    } catch (error) {
      state.error = `This answer may not be recoverable after a page refresh. ${error.message}`;
    }
    const result = await requestJson(`/api/interviews/${state.interview.id}/answers`, {
      method: "POST",
      body: formData
    });
    const answeredInterviewId = state.interview.id;
    const answeredQuestionId = state.interview.questionId;
    try {
      await deletePendingRecording(answeredInterviewId, answeredQuestionId);
    } catch (error) {
      state.error = `Answer saved, but temporary recording cleanup failed. ${error.message}`;
    }
    if (result.complete) {
      const completed = await requestJson(`/api/interviews/${state.interview.id}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      });
      clearRecording();
      sessionStorage.removeItem(ACTIVE_INTERVIEW_KEY);
      state.interview = { ...state.interview, ...completed };
      state.answerSubmitted = false;
      state.busy = false;
      renderInterview();
    } else {
      state.phase = "loadingNext";
      state.recordingStatus = "Answer saved. Loading next question…";
      renderInterview();
      try {
        state.interview = await requestJson(
          `/api/interviews/${state.interview.id}/next-question`,
          { method: "GET" }
        );
        clearRecordedAnswer();
        state.activeQuestionId = null;
        state.error = "";
        startThinkingPhase();
      } catch (error) {
        state.error = `Your answer was saved. The next question could not be loaded yet. ${error.message}`;
        state.phase = "loadingNext";
      }
      state.busy = false;
      renderInterview();
    }
  } catch (error) {
    state.busy = false;
    state.phase = "recorded";
    state.recordingStatus = "Answer ready to retry";
    storeInterviewProgress("recorded");
    state.error = error.message;
    renderInterview();
  }
}

window.addEventListener("beforeunload", () => {
  stopQuestionNarration();
  stopMediaTracks();
  stopProctoringCamera();
  stopMicrophoneTestStream();
  clearMicrophoneTestRecording();
  clearInterviewTimer();
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
  }
});

logoutButton.addEventListener("click", signOut);
requestJson("/api/auth/session")
  .then((result) => {
    state.user = result.user;
    renderAccountActions();
    if (state.user) {
      pruneExpiredRecordings()
        .catch((error) => console.error("Could not clean up expired local recordings.", error))
        .finally(() => restoreInterview().then((restored) => {
          if (!restored) {
            return initializeProctoringFlow();
          }
        }));
    } else {
      renderAuth();
    }
  })
  .catch((error) => {
    state.authError = error.message;
    renderAuth();
  });
