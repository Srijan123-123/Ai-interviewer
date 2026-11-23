require("dotenv").config();
const { createServer } = require("./server");

async function main() {
  if (!process.env.MONGO_URL) {
    console.error("MongoDB check failed: MONGO_URL is not configured.");
    process.exitCode = 1;
    return;
  }

  const { services } = createServer();
  try {
    await services.ready;
    const collections = await services.authService.mongoDb.listCollections({}, { nameOnly: true }).toArray();
    console.log("MongoDB connection successful. Database: " + services.authService.mongoDb.databaseName);
    console.log("Collections ready: " + collections.map(({ name }) => name).sort().join(", "));
  } catch (error) {
    console.error("MongoDB connection failed (" + (error.name || "Error") + (error.code ? ", code " + error.code : "") + ").");
    process.exitCode = 1;
  } finally {
    await services.authService.close();
  }
}

main();
