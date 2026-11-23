const path = require("node:path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { InterviewError } = require("./interview");

const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const MAX_RESUME_TEXT_LENGTH = 30_000;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);
let pdfParseQueue = Promise.resolve();

function parsePdf(buffer) {
  // pdf-parse shares mutable PDF.js state, so parse one PDF at a time.
  const result = pdfParseQueue.then(() => pdfParse(buffer));
  pdfParseQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function extractResume(upload) {
  if (!upload || typeof upload !== "object" || Array.isArray(upload)) {
    throw new InterviewError("Choose a valid resume file.");
  }
  const { filename, contentBase64 } = upload;

  if (typeof filename !== "string" || filename.length > 255) {
    throw new InterviewError("Choose a valid resume file.");
  }
  const extension = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new InterviewError("Upload a PDF, DOCX, TXT, or Markdown resume.");
  }
  if (
    typeof contentBase64 !== "string" ||
    !contentBase64 ||
    contentBase64.length > Math.ceil(MAX_RESUME_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(contentBase64)
  ) {
    throw new InterviewError("Choose a valid resume file no larger than 5 MB.");
  }

  const buffer = Buffer.from(contentBase64, "base64");
  if (!buffer.length || buffer.length > MAX_RESUME_BYTES) {
    throw new InterviewError("Choose a valid resume file no larger than 5 MB.");
  }

  let text;
  try {
    if (extension === ".pdf") {
      if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("Invalid PDF signature.");
      }
      text = (await parsePdf(buffer)).text;
    } else if (extension === ".docx") {
      if (buffer.subarray(0, 2).toString("ascii") !== "PK") {
        throw new Error("Invalid DOCX signature.");
      }
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    }
  } catch {
    throw new InterviewError("We couldn’t read that resume. Try another PDF, DOCX, TXT, or Markdown file.");
  }

  const resumeText = text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t \u00a0]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (resumeText.length < 30) {
    throw new InterviewError("This resume doesn’t contain enough readable text. Try a text-based file.");
  }

  return resumeText.slice(0, MAX_RESUME_TEXT_LENGTH);
}

module.exports = { extractResume, MAX_RESUME_BYTES, MAX_RESUME_TEXT_LENGTH };
