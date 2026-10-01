/**
 * Minimal Prometheus-style metrics (per process). Exposed at GET /api/metrics,
 * which requires METRICS_TOKEN. Label values are bounded (route patterns,
 * provider ids, status classes) to keep cardinality low.
 */
type Labels = Record<string, string>;
type Series = { labels: Labels; value: number };
type Hist = { labels: Labels; buckets: number[]; counts: number[]; sum: number; count: number };

type Store = { counters: Map<string, Map<string, Series>>; hists: Map<string, Map<string, Hist>>; help: Map<string, string> };
const g = globalThis as unknown as { __aiteamMetrics?: Store };
const store: Store = (g.__aiteamMetrics ??= {
  counters: new Map<string, Map<string, Series>>(),
  hists: new Map<string, Map<string, Hist>>(),
  help: new Map<string, string>(),
});

const key = (l: Labels) => JSON.stringify(Object.entries(l).sort());

export function counter(name: string, help: string) {
  store.help.set(name, help);
  return {
    inc(labels: Labels = {}, by = 1) {
      let m = store.counters.get(name);
      if (!m) store.counters.set(name, (m = new Map()));
      const k = key(labels);
      const s = m.get(k) ?? { labels, value: 0 };
      s.value += by;
      m.set(k, s);
    },
  };
}

export function histogram(name: string, help: string, buckets: number[]) {
  store.help.set(name, help);
  return {
    observe(labels: Labels, value: number) {
      let m = store.hists.get(name);
      if (!m) store.hists.set(name, (m = new Map()));
      const k = key(labels);
      const h = m.get(k) ?? { labels, buckets, counts: buckets.map(() => 0), sum: 0, count: 0 };
      buckets.forEach((b, i) => {
        if (value <= b) h.counts[i]!++;
      });
      h.sum += value;
      h.count++;
      m.set(k, h);
    },
  };
}

const fmt = (l: Labels, extra: Labels = {}) => {
  const all = { ...l, ...extra };
  const parts = Object.entries(all).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};

export function renderMetrics(gauges: Record<string, { help: string; value: number }> = {}) {
  const lines: string[] = [];
  for (const [name, series] of store.counters) {
    lines.push(`# HELP ${name} ${store.help.get(name)}`, `# TYPE ${name} counter`);
    for (const s of series.values()) lines.push(`${name}${fmt(s.labels)} ${s.value}`);
  }
  for (const [name, series] of store.hists) {
    lines.push(`# HELP ${name} ${store.help.get(name)}`, `# TYPE ${name} histogram`);
    for (const h of series.values()) {
      h.buckets.forEach((b, i) => lines.push(`${name}_bucket${fmt(h.labels, { le: String(b) })} ${h.counts[i]}`));
      lines.push(`${name}_bucket${fmt(h.labels, { le: "+Inf" })} ${h.count}`);
      lines.push(`${name}_sum${fmt(h.labels)} ${h.sum}`, `${name}_count${fmt(h.labels)} ${h.count}`);
    }
  }
  for (const [name, gauge] of Object.entries(gauges)) {
    lines.push(`# HELP ${name} ${gauge.help}`, `# TYPE ${name} gauge`, `${name} ${gauge.value}`);
  }
  return lines.join("\n") + "\n";
}

export const metrics = {
  httpRequests: counter("aiteam_http_requests_total", "HTTP API requests by route and status class"),
  httpDuration: histogram("aiteam_http_request_duration_seconds", "HTTP API latency", [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
  providerCalls: counter("aiteam_provider_calls_total", "Provider calls by provider, kind and outcome"),
  providerDuration: histogram("aiteam_provider_call_duration_seconds", "Provider call latency", [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]),
  providerTokens: counter("aiteam_provider_tokens_total", "Tokens reported by providers"),
  runs: counter("aiteam_runs_total", "Finished orchestration runs by status"),
};
