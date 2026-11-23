const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { extractResume } = require("./resume");
const { InterviewError } = require("./interview");

function encode(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

test("extracts readable text resumes", async () => {
  const resumeText = "Software engineer with experience building reliable APIs and services.";
  const result = await extractResume({
    filename: "resume.txt",
    contentBase64: encode(resumeText)
  });

  assert.equal(result, resumeText);
});

test("normalizes whitespace and formatting artifacts from text resumes", async () => {
  const result = await extractResume({
    filename: "resume.txt",
    contentBase64: encode("Software\t engineer  \r\n\r\n\r\n Built reliable   APIs.")
  });

  assert.equal(result, "Software engineer\n\nBuilt reliable APIs.");
});

test("extracts readable text from Markdown resumes", async () => {
  const markdown = "# Backend Developer\n\nSkills: Node.js, Express, and PostgreSQL.";
  const result = await extractResume({
    filename: "resume.md",
    contentBase64: encode(markdown)
  });

  assert.equal(result, markdown);
});

test("extracts text from PDF resumes", async () => {
  const pdfPath = path.join(path.dirname(require.resolve("pdf-parse")), "test", "data", "04-valid.pdf");
  const result = await extractResume({
    filename: "resume.pdf",
    contentBase64: fs.readFileSync(pdfPath).toString("base64")
  });

  assert.match(result, /Turk J Med Sci/);
});

test("extracts text from DOCX resumes", async () => {
  const docxPath = path.join(path.dirname(require.resolve("mammoth")), "..", "test", "test-data", "tables.docx");
  const result = await extractResume({
    filename: "resume.docx",
    contentBase64: fs.readFileSync(docxPath).toString("base64")
  });

  assert.match(result, /Top left/);
});

test("rejects unsupported, invalid, and unreadable resume uploads", async () => {
  await assert.rejects(
    () => extractResume(null),
    (error) => error instanceof InterviewError && error.statusCode === 400
  );
  await assert.rejects(
    () => extractResume({ filename: "resume.exe", contentBase64: encode("resume content") }),
    (error) => error instanceof InterviewError && error.statusCode === 400
  );
  await assert.rejects(
    () => extractResume({ filename: "resume.pdf", contentBase64: encode("not a PDF resume") }),
    (error) => error instanceof InterviewError && error.statusCode === 400
  );
  await assert.rejects(
    () => extractResume({ filename: "resume.txt", contentBase64: "invalid-base64" }),
    (error) => error instanceof InterviewError && error.statusCode === 400
  );
  await assert.rejects(
    () => extractResume({ filename: "resume.txt", contentBase64: encode("too short") }),
    (error) => error instanceof InterviewError && error.statusCode === 400
  );
});
