import type { Instrumentation } from "next";

export async function register() {
  // Background work only runs in the Node.js server runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startLifecycle } = await import("./server/lifecycle");
  await startLifecycle();
}

/** Errors Next.js catches outside our route wrapper, logged through the redacting logger. */
export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("./server/security/redact");
  log.error(`request error ${request.method} ${request.path.split("?")[0]}`, err);
};
