class AppPersistence {
  constructor(db) {
    this.db = db;
    this.analyses = db.collection("resume_analyses");
    this.interviews = db.collection("interviews");
    this.proctoring = db.collection("proctoring_sessions");
  }

  async initialize(services) {
    await Promise.all([
      this.ensureCollection("resume_analyses", {
        bsonType: "object",
        required: ["_id", "owner", "data", "expiresAt"],
        properties: {
          _id: { bsonType: "string" },
          owner: { bsonType: "string" },
          data: { bsonType: "object" },
          expiresAt: { bsonType: "date" }
        }
      }),
      this.ensureCollection("interviews", {
        bsonType: "object",
        required: ["_id", "owner", "data", "expiresAt"],
        properties: {
          _id: { bsonType: "string" },
          owner: { bsonType: "string" },
          data: { bsonType: "object" },
          expiresAt: { bsonType: "date" }
        }
      }),
      this.ensureCollection("proctoring_sessions", {
        bsonType: "object",
        required: ["_id", "data", "expiresAt"],
        properties: {
          _id: { bsonType: "string" },
          data: { bsonType: "object" },
          expiresAt: { bsonType: "date" }
        }
      })
    ]);
    await Promise.all([
      this.analyses.createIndex({ owner: 1 }),
      this.analyses.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.interviews.createIndex({ owner: 1 }),
      this.interviews.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.proctoring.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]);

    const now = new Date();
    const [analyses, interviews, profiles] = await Promise.all([
      this.analyses.find({ expiresAt: { $gt: now } }).toArray(),
      this.interviews.find({ expiresAt: { $gt: now } }).toArray(),
      this.proctoring.find({ expiresAt: { $gt: now } }).toArray()
    ]);
    for (const document of analyses) {
      services.resumeAnalysisService.analyses.set(document._id, {
        ...document.data,
        expiresAt: document.expiresAt.getTime()
      });
    }
    for (const document of interviews) {
      const data = document.data;
      // A process restart ends an in-flight transcription reservation; the answer can be retried.
      data.processingToken = null;
      services.interviewService.sessions.set(document._id, {
        ...data,
        expiresAt: document.expiresAt.getTime()
      });
    }
    for (const document of profiles) {
      services.proctoringService.sessions.set(document._id, {
        ...document.data,
        expiresAt: document.expiresAt.getTime()
      });
    }
  }

  async ensureCollection(name, validator) {
    try {
      await this.db.createCollection(name, { validator: { $jsonSchema: validator }, validationLevel: "strict" });
    } catch (error) {
      if (error.codeName !== "NamespaceExists") throw error;
      await this.db.command({
        collMod: name,
        validator: { $jsonSchema: validator },
        validationLevel: "strict"
      });
    }
  }

  async persist(services) {
    const operations = [];
    for (const [id, data] of services.resumeAnalysisService.analyses) {
      if (data.expiresAt > Date.now()) {
        operations.push(this.analyses.replaceOne(
          { _id: id },
          { _id: id, owner: data.owner, data, expiresAt: new Date(data.expiresAt) },
          { upsert: true }
        ));
      }
    }
    for (const [id, data] of services.interviewService.sessions) {
      if (data.expiresAt > Date.now()) {
        operations.push(this.interviews.replaceOne(
          { _id: id },
          { _id: id, owner: data.owner, data, expiresAt: new Date(data.expiresAt) },
          { upsert: true }
        ));
      }
    }
    for (const [email, data] of services.proctoringService.sessions) {
      if (data.expiresAt > Date.now()) {
        operations.push(this.proctoring.replaceOne(
          { _id: email },
          { _id: email, data, expiresAt: new Date(data.expiresAt) },
          { upsert: true }
        ));
      }
    }
    await Promise.all(operations);
  }
}

module.exports = { AppPersistence };
