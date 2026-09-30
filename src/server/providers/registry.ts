import { sandboxEnabled } from "../env";
import { AnthropicProvider } from "./anthropic";
import { CursorProvider } from "./cursor";
import { GoogleProvider } from "./google";
import { OpenAIProvider } from "./openai";
import { SandboxAdapter } from "./sandbox";
import type { ConnectionMethodInfo, MethodId, ProviderAdapter, ProviderId } from "./types";
import { XAIProvider } from "./xai";

/** Display order. Add new providers here after implementing ProviderAdapter. */
export const PROVIDER_IDS: ProviderId[] = ["openai", "anthropic", "google", "xai", "cursor"];

const adapters: Record<ProviderId, ProviderAdapter> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  google: new GoogleProvider(),
  xai: new XAIProvider(),
  cursor: new CursorProvider(),
};

const sandboxes = new Map<ProviderId, SandboxAdapter>();

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as string[]).includes(value);
}

export function getAdapter(id: ProviderId): ProviderAdapter {
  return adapters[id];
}

/** The adapter that actually serves requests for a stored connection method. */
export function runtimeAdapter(id: ProviderId, method: MethodId): ProviderAdapter {
  if (method !== "sandbox") return adapters[id];
  if (!sandboxEnabled()) throw new Error("Sandbox agents are disabled on this server");
  let s = sandboxes.get(id);
  if (!s) sandboxes.set(id, (s = new SandboxAdapter(adapters[id])));
  return s;
}

export function methodsFor(id: ProviderId): ConnectionMethodInfo[] {
  const methods = adapters[id].methods();
  if (!sandboxEnabled()) return methods;
  return [
    ...methods,
    {
      id: "sandbox",
      label: "Sandbox (simulated)",
      availability: "available",
      billing: "Free — deterministic simulated output for local development only",
      subscriptionDelegation: false,
    },
  ];
}

/** Only used by tests. */
export function overrideAdapter(id: ProviderId, adapter: ProviderAdapter) {
  adapters[id] = adapter;
  sandboxes.delete(id);
}
