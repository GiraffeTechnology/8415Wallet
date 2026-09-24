export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/**
 * Counters for monitoring.
 *
 * Labels carry the tenant, the route and the outcome, never a token id, holder
 * address, commitment or registry reference: a metrics endpoint is usually the
 * least protected surface a deployment has, and projection data does not
 * belong on it.
 */
export class Metrics {
  readonly #counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>();

  static readonly FORBIDDEN_LABELS = ['tokenId', 'holder', 'commitment', 'registryReference', 'settlementId'];

  increment(name: string, labels: Readonly<Record<string, string>> = {}, by = 1): void {
    for (const key of Object.keys(labels)) {
      if (Metrics.FORBIDDEN_LABELS.includes(key)) {
        throw new Error(`metric label ${key} would put projection data on the metrics surface`);
      }
    }
    const key = `${name}|${JSON.stringify(Object.entries(labels).sort())}`;
    const existing = this.#counters.get(key);
    if (existing === undefined) this.#counters.set(key, { name, labels: { ...labels }, value: by });
    else existing.value += by;
  }

  samples(): readonly MetricSample[] {
    return [...this.#counters.values()]
      .map((counter) => ({ name: counter.name, labels: counter.labels, value: counter.value }))
      .sort((a, b) => a.name.localeCompare(b.name) || JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));
  }

  /** Prometheus text exposition. */
  render(): string {
    return this.samples()
      .map((sample) => {
        const labels = Object.entries(sample.labels)
          .map(([key, value]) => `${key}="${value.replace(/"/g, '\\"')}"`)
          .join(',');
        return `${sample.name}${labels.length > 0 ? `{${labels}}` : ''} ${sample.value}`;
      })
      .join('\n');
  }
}
