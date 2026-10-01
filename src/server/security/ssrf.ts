import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Outbound-request guard for user-supplied URLs (webhooks). Blocks loopback,
 * private, link-local, CGNAT, multicast, reserved and metadata addresses, for
 * IPv4, IPv6 and IPv4-mapped IPv6. The caller must connect to the returned
 * address (not re-resolve the hostname) so DNS rebinding can't swap it.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return !blocked.check(mapped[1]!, "ipv4");
    return !blocked.check(address, "ipv6");
  }
  return false;
}

export class UnsafeUrlError extends Error {}

export type ResolvedTarget = { url: URL; address: string; family: 4 | 6 };

export async function resolveSafeUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  if (url.protocol !== "https:" && !(opts.allowPrivate && url.protocol === "http:")) {
    throw new UnsafeUrlError("Webhook URLs must use https");
  }
  if (url.port && !["443", "8443"].includes(url.port) && !opts.allowPrivate) throw new UnsafeUrlError("Only ports 443 and 8443 are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new UnsafeUrlError("Host did not resolve");
  if (!opts.allowPrivate && addresses.some((a) => !isPublicAddress(a.address))) {
    throw new UnsafeUrlError("Webhook URLs must resolve to public addresses");
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family as 4 | 6 };
}
