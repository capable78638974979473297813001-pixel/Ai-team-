export async function register() {
  // Background work only runs in the Node.js server runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startLifecycle } = await import("./server/lifecycle");
  await startLifecycle();
}
