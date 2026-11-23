(function initializeQuestionNarration(global) {
  const VOICE_WAIT_MS = 700;
  let generation = 0;

  function isSupported() {
    return Boolean(
      global.speechSynthesis &&
      typeof global.speechSynthesis.speak === "function" &&
      typeof global.speechSynthesis.getVoices === "function" &&
      typeof global.SpeechSynthesisUtterance === "function"
    );
  }

  function cancel() {
    generation += 1;
    if (isSupported()) {
      try {
        global.speechSynthesis.cancel();
      } catch {
        return;
      }
    }
  }

  function findEnglishVoice(voices) {
    const englishVoices = voices.filter((voice) => /^en(?:-|$)/iu.test(voice.lang || ""));
    return englishVoices.find((voice) => /^en-US$/iu.test(voice.lang || "")) ||
      englishVoices.find((voice) => /^en-GB$/iu.test(voice.lang || "")) ||
      englishVoices[0] ||
      null;
  }

  function getEnglishVoice() {
    const synthesis = global.speechSynthesis;
    let availableVoices;
    try {
      availableVoices = synthesis.getVoices();
    } catch {
      return Promise.resolve(null);
    }
    const immediateVoice = findEnglishVoice(availableVoices);
    if (immediateVoice || availableVoices.length > 0) {
      return Promise.resolve(immediateVoice);
    }

    return new Promise((resolve) => {
      let timeout;
      const finish = () => {
        global.clearTimeout(timeout);
        synthesis.removeEventListener?.("voiceschanged", onVoicesChanged);
        resolve(findEnglishVoice(synthesis.getVoices()));
      };
      const onVoicesChanged = () => {
        if (findEnglishVoice(synthesis.getVoices())) {
          finish();
        }
      };
      synthesis.addEventListener?.("voiceschanged", onVoicesChanged);
      timeout = global.setTimeout(finish, VOICE_WAIT_MS);
    });
  }

  async function speakQuestion(questionText) {
    if (!isSupported() || typeof questionText !== "string" || !questionText.trim()) {
      return false;
    }
    try {
      cancel();
      const requestGeneration = generation;
      const voice = await getEnglishVoice();
      if (requestGeneration !== generation || !voice) {
        return false;
      }

      return await new Promise((resolve) => {
        const utterance = new global.SpeechSynthesisUtterance(questionText);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.rate = 0.95;
        utterance.pitch = 1;
        utterance.volume = 1;
        utterance.onend = () => resolve(requestGeneration === generation);
        utterance.onerror = () => resolve(false);
        try {
          global.speechSynthesis.speak(utterance);
        } catch {
          resolve(false);
        }
      });
    } catch {
      return false;
    }
  }

  const api = { cancel, findEnglishVoice, isSupported, speakQuestion };
  global.QuestionNarration = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
