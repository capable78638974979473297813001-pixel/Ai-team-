import { api } from "@/server/auth/guard";
import { getAdapter, methodsFor, PROVIDER_IDS } from "@/server/providers/registry";

/** Supported providers, their connection methods and declared capabilities (no user data). */
export const GET = api({ auth: false }, async () => ({
  providers: PROVIDER_IDS.map((id) => {
    const a = getAdapter(id);
    return {
      id,
      name: a.info.name,
      product: a.info.product,
      vendor: a.info.vendor,
      strength: a.info.strength,
      docsUrl: a.info.docsUrl,
      capabilities: a.capabilities("api_key"),
      methods: methodsFor(id).map(({ apiKey, ...m }) => ({ ...m, apiKey: apiKey ? { consoleUrl: apiKey.consoleUrl, prefix: apiKey.prefix } : undefined })),
    };
  }),
}));
