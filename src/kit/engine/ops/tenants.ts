import type { ProjectionStore } from '../projection/store.ts';

export class UnknownTenant extends Error {
  constructor(tenantId: string) {
    super(`no such tenant: ${tenantId}`);
    this.name = 'UnknownTenant';
  }
}

/**
 * One projection store per tenant.
 *
 * Isolation is structural: a request resolves to exactly one store through its
 * tenant, and no method here can reach across. There is no "all tenants" read
 * and no store shared between them, so a query cannot cross a boundary by
 * forgetting a filter.
 */
export class TenantRegistry {
  readonly #stores = new Map<string, ProjectionStore>();

  add(tenantId: string, store: ProjectionStore): void {
    this.#stores.set(tenantId, store);
  }

  storeFor(tenantId: string): ProjectionStore {
    const store = this.#stores.get(tenantId);
    if (store === undefined) throw new UnknownTenant(tenantId);
    return store;
  }

  has(tenantId: string): boolean {
    return this.#stores.has(tenantId);
  }

  tenants(): readonly string[] {
    return [...this.#stores.keys()].sort();
  }
}
