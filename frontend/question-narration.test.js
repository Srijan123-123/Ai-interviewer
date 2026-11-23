const test = require("node:test");
const assert = require("node:assert/strict");
const narration = require("./question-narration");

test("prefers US English and then GB English voices", () => {
  const voices = [
    { lang: "fr-FR", name: "French" },
    { lang: "en-GB", name: "British English" },
    { lang: "en-US", name: "American English" }
  ];

  assert.equal(narration.findEnglishVoice(voices).name, "American English");
  assert.equal(narration.findEnglishVoice(voices.slice(0, 2)).name, "British English");
  assert.equal(narration.findEnglishVoice(voices.slice(0, 1)), null);
});

test("speaks only the provided question text with natural English voice settings", async (t) => {
  const originalSynthesis = globalThis.speechSynthesis;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const spoken = [];
  let cancelCount = 0;
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  globalThis.speechSynthesis = {
    getVoices: () => [
      { lang: "en-GB", name: "British English" },
      { lang: "es-ES", name: "Spanish" }
    ],
    cancel: () => { cancelCount += 1; },
    speak: (utterance) => {
      spoken.push(utterance);
      utterance.onend();
    }
  };
  t.after(() => {
    globalThis.speechSynthesis = originalSynthesis;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  });

  const result = await narration.speakQuestion("How did you structure the project?");

  assert.equal(result, true);
  assert.equal(cancelCount, 1);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "How did you structure the project?");
  assert.equal(spoken[0].voice.name, "British English");
  assert.equal(spoken[0].rate, 0.95);
  assert.equal(spoken[0].pitch, 1);
});

test("does not resolve question narration until speech finishes", async (t) => {
  const originalSynthesis = globalThis.speechSynthesis;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  let activeUtterance;
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  globalThis.speechSynthesis = {
    getVoices: () => [{ lang: "en-US", name: "English" }],
    cancel() {},
    speak: (utterance) => { activeUtterance = utterance; }
  };
  t.after(() => {
    globalThis.speechSynthesis = originalSynthesis;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  });

  let finished = false;
  const pending = narration.speakQuestion("How did you solve the problem?")
    .then((result) => {
      finished = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);

  activeUtterance.onend();
  assert.equal(await pending, true);
  assert.equal(finished, true);
});

test("cancels the previous question before narrating a replay or next question", async (t) => {
  const originalSynthesis = globalThis.speechSynthesis;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  const spoken = [];
  let cancelCount = 0;
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  globalThis.speechSynthesis = {
    getVoices: () => [{ lang: "en-US", name: "English" }],
    cancel: () => { cancelCount += 1; },
    speak: (utterance) => { spoken.push(utterance); }
  };
  t.after(() => {
    globalThis.speechSynthesis = originalSynthesis;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  });

  const firstQuestion = narration.speakQuestion("First question?");
  await new Promise((resolve) => setImmediate(resolve));
  const replay = narration.speakQuestion("First question?");
  await new Promise((resolve) => setImmediate(resolve));
  const nextQuestion = narration.speakQuestion("Second question?");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCount, 3);
  assert.equal(spoken.length, 3);
  assert.equal(spoken[0].text, "First question?");
  assert.equal(spoken[1].text, "First question?");
  assert.equal(spoken[2].text, "Second question?");
  spoken[0].onend();
  spoken[1].onend();
  spoken[2].onend();
  assert.equal(await firstQuestion, false);
  assert.equal(await replay, false);
  assert.equal(await nextQuestion, true);
});

test("gracefully skips narration when Web Speech or an English voice is unavailable", async (t) => {
  const originalSynthesis = globalThis.speechSynthesis;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance = class {};
  globalThis.speechSynthesis = {
    getVoices: () => [{ lang: "de-DE", name: "German" }],
    cancel() {},
    speak() {
      assert.fail("Should not speak with a non-English voice.");
    }
  };
  t.after(() => {
    globalThis.speechSynthesis = originalSynthesis;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  });

  assert.equal(await narration.speakQuestion("What did you build?"), false);
});

test("cancels a pending question before it can start speaking", async (t) => {
  const originalSynthesis = globalThis.speechSynthesis;
  const originalUtterance = globalThis.SpeechSynthesisUtterance;
  let spokenCount = 0;
  globalThis.SpeechSynthesisUtterance = class {};
  globalThis.speechSynthesis = {
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    cancel() {},
    speak() { spokenCount += 1; }
  };
  t.after(() => {
    globalThis.speechSynthesis = originalSynthesis;
    globalThis.SpeechSynthesisUtterance = originalUtterance;
  });

  const pending = narration.speakQuestion("Question one?");
  narration.cancel();

  assert.equal(await pending, false);
  assert.equal(spokenCount, 0);
});
