import { buildApp } from "./app.js";

const app = await buildApp();

try {
  await app.listen({
    host: app.config.API_HOST,
    port: app.config.API_PORT
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
