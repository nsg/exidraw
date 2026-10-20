import { createBackend } from "./app.js";
import { parseConfig } from "./config.js";
async function main() {
  let backend: ReturnType<typeof createBackend>;
  try {
    backend = createBackend(parseConfig());
    await backend.start();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      backend.log.error("Shutdown exceeded five seconds");
      process.exit(1);
    }, 4900);
    deadline.unref();
    void backend.close().then(
      () => {
        clearTimeout(deadline);
        process.exitCode = 0;
      },
      (error) => {
        backend.log.error({ err: error }, "Shutdown failed");
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
await main();
