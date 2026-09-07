import { loadConfig } from "@aegix/config";
import { buildServer } from "./server.js";

const config = loadConfig();

const app = await buildServer({ config });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const timeout = setTimeout(() => {
    console.error(`API shutdown timed out after receiving ${signal}`);
    process.exit(1);
  }, 25_000);
  timeout.unref();

  try {
    // Fastify stops accepting new requests, drains in-flight requests, then
    // runs the onClose hook that closes queues, Redis, and PostgreSQL.
    await app.close();
    clearTimeout(timeout);
  } catch (error) {
    clearTimeout(timeout);
    console.error("API shutdown failed", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
