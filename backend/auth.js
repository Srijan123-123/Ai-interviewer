const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { createHmac, randomBytes, scrypt: nodeScrypt, timingSafeEqual } = require("node:crypto");
const { MongoClient } = require("mongodb");

const scrypt = promisify(nodeScrypt);
const PASSWORD_BYTES = 64;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const JWT_ISSUER = "clearview-interview-practice";
const JWT_AUDIENCE = "clearview-web";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

class AuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

class AuthService {
  constructor(accountFile, {
    mongoUrl = process.env.MONGO_URL,
    jwtSecret = process.env.JWT_SECRET || randomBytes(48).toString("base64url")
  } = {}) {
    this.accountFile = accountFile;
    this.accounts = new Map();
    this.sessions = new Map();
    this.accountOperations = Promise.resolve();
    this.mongoUrl = mongoUrl;
    this.jwtSecret = jwtSecret;
    if (process.env.NODE_ENV === "production" && Buffer.byteLength(jwtSecret) < 32) {
      throw new Error("JWT_SECRET must be configured with at least 32 bytes in production.");
    }
    this.mongoClient = mongoUrl ? new MongoClient(mongoUrl) : null;
    this.mongoDb = null;
    this.ready = this.mongoClient ? this.initializeMongo() : Promise.resolve();
    if (!this.mongoClient) this.loadAccounts();
  }

  async initializeMongo() {
    await this.mongoClient.connect();
    const url = new URL(this.mongoUrl);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, "")) || "ai_interviewer";
    this.mongoDb = this.mongoClient.db(databaseName);
    await this.ensureCollection("users", {
      bsonType: "object",
      required: ["email", "salt", "passwordHash"],
      properties: {
        email: { bsonType: "string" },
        salt: { bsonType: "string", pattern: "^[0-9a-fA-F]{32}$" },
        passwordHash: { bsonType: "string", pattern: "^[0-9a-fA-F]{128}$" },
        createdAt: { bsonType: "date" }
      }
    });
    const sessionCollection = this.mongoDb.collection("sessions");
    try {
      await sessionCollection.dropIndex("token_1");
    } catch (error) {
      if (error.codeName !== "IndexNotFound") throw error;
    }
    await sessionCollection.deleteMany({ token: { $exists: true }, jti: { $exists: false } });
    await this.ensureCollection("sessions", {
      bsonType: "object",
      required: ["jti", "email", "expiresAt"],
      properties: {
        jti: { bsonType: "string", pattern: "^[0-9a-fA-F]{64}$" },
        email: { bsonType: "string" },
        expiresAt: { bsonType: "date" }
      }
    });
    await Promise.all([
      this.mongoDb.collection("users").createIndex({ email: 1 }, { unique: true }),
      sessionCollection.createIndex(
        { jti: 1 },
        { unique: true, partialFilterExpression: { jti: { $type: "string" } } }
      ),
      sessionCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]);

    // Import existing local accounts once, preserving their password hashes.
    try {
      const contents = await fs.promises.readFile(this.accountFile, "utf8");
      const accounts = JSON.parse(contents);
      if (!Array.isArray(accounts)) throw new Error("The local account file has an invalid format.");
      if (accounts.length) {
        await this.mongoDb.collection("users").bulkWrite(accounts.map((account) => ({
          updateOne: {
            filter: { email: account.email },
            update: { $setOnInsert: account },
            upsert: true
          }
        })));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async ensureCollection(name, validator) {
    try {
      await this.mongoDb.createCollection(name, { validator: { $jsonSchema: validator }, validationLevel: "strict" });
    } catch (error) {
      if (error.codeName !== "NamespaceExists") throw error;
      await this.mongoDb.command({
        collMod: name,
        validator: { $jsonSchema: validator },
        validationLevel: "strict"
      });
    }
  }

  async close() {
    if (this.mongoClient) await this.mongoClient.close();
  }

  loadAccounts() {
    let contents;
    try {
      contents = fs.readFileSync(this.accountFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    const accounts = JSON.parse(contents);
    if (!Array.isArray(accounts)) {
      throw new Error("The local account file has an invalid format.");
    }

    for (const account of accounts) {
      if (
        !account ||
        typeof account.email !== "string" ||
        typeof account.salt !== "string" ||
        typeof account.passwordHash !== "string" ||
        !/^[0-9a-f]{32}$/i.test(account.salt) ||
        !new RegExp(`^[0-9a-f]{${PASSWORD_BYTES * 2}}$`, "i").test(account.passwordHash)
      ) {
        throw new Error("The local account file contains an invalid account.");
      }
      this.accounts.set(account.email, account);
    }
  }

  normalizeEmail(email) {
    if (typeof email !== "string") {
      throw new AuthError("Enter a valid email address.");
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail)) {
      throw new AuthError("Enter a valid email address.");
    }
    return normalizedEmail;
  }

  validatePassword(password) {
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
      throw new AuthError("Use a password between 12 and 128 characters.");
    }
  }

  async register(email, password) {
    await this.ready;
    const normalizedEmail = this.normalizeEmail(email);
    this.validatePassword(password);
    const salt = randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, PASSWORD_BYTES)).toString("hex");

    await this.runAccountOperation(async () => {
      if (this.mongoDb) {
        try {
          await this.mongoDb.collection("users").insertOne({ email: normalizedEmail, salt, passwordHash, createdAt: new Date() });
        } catch (error) {
          if (error.code === 11000) throw new AuthError("An account with this email already exists.", 409);
          throw error;
        }
        return;
      }
      if (this.accounts.has(normalizedEmail)) {
        throw new AuthError("An account with this email already exists.", 409);
      }
      this.accounts.set(normalizedEmail, { email: normalizedEmail, salt, passwordHash });
      try {
        await this.saveAccounts();
      } catch (error) {
        this.accounts.delete(normalizedEmail);
        throw error;
      }
    });

    return { user: { email: normalizedEmail }, sessionToken: await this.createSession(normalizedEmail) };
  }

  async login(email, password) {
    await this.ready;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const account = this.mongoDb
      ? await this.mongoDb.collection("users").findOne({ email: normalizedEmail })
      : this.accounts.get(normalizedEmail);
    const validPasswordShape = typeof password === "string" && password.length <= 128;
    const candidatePassword = validPasswordShape ? password : "";
    const salt = account ? account.salt : "00000000000000000000000000000000";
    const expectedHash = account
      ? Buffer.from(account.passwordHash, "hex")
      : Buffer.alloc(PASSWORD_BYTES);
    const candidateHash = await scrypt(candidatePassword, salt, PASSWORD_BYTES);
    const passwordMatches = timingSafeEqual(candidateHash, expectedHash);

    if (!EMAIL_PATTERN.test(normalizedEmail) || !validPasswordShape || !account || !passwordMatches) {
      throw new AuthError("Email or password is incorrect.", 401);
    }

    return { user: { email: account.email }, sessionToken: await this.createSession(account.email) };
  }

  async createSession(email) {
    const jti = randomBytes(32).toString("hex");
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = issuedAt + SESSION_LIFETIME_MS / 1000;
    const token = this.signJwt({
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: email,
      jti,
      iat: issuedAt,
      exp: expiresAtSeconds
    });
    const expiresAt = new Date(expiresAtSeconds * 1000);
    if (this.mongoDb) {
      await this.mongoDb.collection("sessions").insertOne({
        jti,
        email,
        expiresAt
      });
      return token;
    }
    this.sessions.set(token, {
      email,
      jti,
      expiresAt: expiresAt.getTime()
    });
    return token;
  }

  getUser(sessionToken) {
    const claims = this.verifyJwt(sessionToken);
    if (!claims) return null;
    if (this.mongoDb) {
      return this.mongoDb.collection("sessions").findOne({
        jti: claims.jti,
        email: claims.sub,
        expiresAt: { $gt: new Date() }
      })
        .then((session) => session ? { email: session.email } : null);
    }
    const session = this.sessions.get(sessionToken);
    if (!session || session.jti !== claims.jti || session.email !== claims.sub) {
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionToken);
      return null;
    }
    return { email: session.email };
  }

  logout(sessionToken) {
    const claims = this.verifyJwt(sessionToken);
    if (!claims) return this.mongoDb ? Promise.resolve() : undefined;
    if (this.mongoDb) {
      return this.mongoDb.collection("sessions").deleteOne({ jti: claims.jti, email: claims.sub });
    }
    this.sessions.delete(sessionToken);
  }

  signJwt(payload) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const unsignedToken = `${header}.${body}`;
    const signature = createHmac("sha256", this.jwtSecret).update(unsignedToken).digest("base64url");
    return `${unsignedToken}.${signature}`;
  }

  verifyJwt(token) {
    if (typeof token !== "string" || token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!header || header.alg !== "HS256" || header.typ !== "JWT") return null;
    const expected = createHmac("sha256", this.jwtSecret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    let supplied;
    try {
      supplied = Buffer.from(encodedSignature, "base64url");
    } catch {
      return null;
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (
      !payload ||
      payload.iss !== JWT_ISSUER ||
      payload.aud !== JWT_AUDIENCE ||
      typeof payload.sub !== "string" ||
      !/^[0-9a-f]{64}$/iu.test(payload.jti || "") ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat > now + 60 ||
      payload.exp <= now ||
      payload.exp - payload.iat > SESSION_LIFETIME_MS / 1000
    ) return null;
    return payload;
  }

  async runAccountOperation(operation) {
    const previousOperation = this.accountOperations;
    let release;
    this.accountOperations = new Promise((resolve) => {
      release = resolve;
    });
    await previousOperation;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async saveAccounts() {
    const directory = path.dirname(this.accountFile);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.accountFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const contents = JSON.stringify(Array.from(this.accounts.values()));
    await fs.promises.writeFile(temporaryFile, contents, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporaryFile, this.accountFile);
  }
}

module.exports = { AuthError, AuthService };
