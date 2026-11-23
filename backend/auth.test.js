const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AuthError, AuthService } = require("./auth");

function createTemporaryAccountFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clearview-auth-"));
  return {
    directory,
    accountFile: path.join(directory, "accounts.json")
  };
}

test("registers an account with a password hash and restores it after restart", async (context) => {
  const { directory, accountFile } = createTemporaryAccountFile();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = new AuthService(accountFile);

  const registration = await auth.register("Alex@example.com", "a-secure-passphrase");
  await auth.register("sam@example.com", "another-secure-passphrase");
  const savedAccount = JSON.parse(fs.readFileSync(accountFile, "utf8"))[0];
  const restoredAuth = new AuthService(accountFile);
  const login = await restoredAuth.login("alex@example.com", "a-secure-passphrase");
  const secondLogin = await restoredAuth.login("sam@example.com", "another-secure-passphrase");

  assert.equal(registration.user.email, "alex@example.com");
  assert.equal(restoredAuth.getUser(login.sessionToken).email, "alex@example.com");
  assert.equal(restoredAuth.getUser(secondLogin.sessionToken).email, "sam@example.com");
  assert.equal(JSON.parse(fs.readFileSync(accountFile, "utf8")).length, 2);
  assert.notEqual(savedAccount.passwordHash, "a-secure-passphrase");
  assert.equal(savedAccount.passwordHash.length, 128);
  assert.equal(fs.existsSync(accountFile), true);
});

test("rejects duplicate accounts, weak passwords, and incorrect credentials", async () => {
  const { directory, accountFile } = createTemporaryAccountFile();
  try {
    const auth = new AuthService(accountFile);
    await assert.rejects(
      () => auth.register("not-an-email", "a-secure-passphrase"),
      (error) => error instanceof AuthError && error.statusCode === 400
    );
    await assert.rejects(
      () => auth.register("alex@example.com", "short"),
      (error) => error instanceof AuthError && error.statusCode === 400
    );

    await auth.register("alex@example.com", "a-secure-passphrase");
    await assert.rejects(
      () => auth.register("ALEX@example.com", "another-secure-passphrase"),
      (error) => error instanceof AuthError && error.statusCode === 409
    );
    await assert.rejects(
      () => auth.login("alex@example.com", "incorrect-passphrase"),
      (error) => error instanceof AuthError && error.statusCode === 401
    );
    await assert.rejects(
      () => auth.login("missing@example.com", "incorrect-passphrase"),
      (error) => error instanceof AuthError && error.statusCode === 401
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("prevents concurrent registrations from creating duplicate accounts", async (context) => {
  const { directory, accountFile } = createTemporaryAccountFile();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = new AuthService(accountFile);
  const results = await Promise.allSettled([
    auth.register("alex@example.com", "a-secure-passphrase"),
    auth.register("alex@example.com", "another-secure-passphrase")
  ]);
  const successfulRegistrations = results.filter((result) => result.status === "fulfilled");
  const rejectedRegistrations = results.filter((result) => result.status === "rejected");

  assert.equal(successfulRegistrations.length, 1);
  assert.equal(rejectedRegistrations.length, 1);
  assert.ok(rejectedRegistrations[0].reason instanceof AuthError);
  assert.equal(rejectedRegistrations[0].reason.statusCode, 409);
  assert.equal(JSON.parse(fs.readFileSync(accountFile, "utf8")).length, 1);
});

test("expires and revokes authenticated sessions", async (context) => {
  const { directory, accountFile } = createTemporaryAccountFile();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = new AuthService(accountFile);
  const registration = await auth.register("alex@example.com", "a-secure-passphrase");
  auth.sessions.get(registration.sessionToken).expiresAt = Date.now() - 1;
  assert.equal(auth.getUser(registration.sessionToken), null);

  const login = await auth.login("alex@example.com", "a-secure-passphrase");
  assert.equal(auth.getUser(login.sessionToken).email, "alex@example.com");
  auth.logout(login.sessionToken);
  assert.equal(auth.getUser(login.sessionToken), null);
});
