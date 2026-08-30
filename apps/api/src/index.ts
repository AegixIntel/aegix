import { loadConfig } from "@aegix/config";
import { buildServer } from "./server.js";

const config = loadConfig();

const app = await buildServer({ config });

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
