import type { Clock } from '../engine/ports.ts';
import { handle, type ApiRequest, type ApiResponse } from './routes.ts';
import { UnknownTenant, type TenantRegistry } from '../engine/ops/tenants.ts';
import type { ApiKeyStore } from '../engine/ops/apiKeys.ts';
import type { Metrics } from '../engine/ops/metrics.ts';

export interface GatewayOptions {
  readonly tenants: TenantRegistry;
  readonly keys: ApiKeyStore;
  readonly metrics: Metrics;
  /** Trusted server time, never derived from the request. Defaults to Unix wall time. */
  readonly clock?: Clock;
}

export interface GatewayRequest extends ApiRequest {
  /** Bearer secret. Absent means unauthenticated. */
  readonly apiKey?: string;
}

/**
 * Authenticates a request, resolves its tenant, and meters the outcome.
 *
 * The tenant comes from the key, never from the request, so a caller cannot
 * name a tenant it does not hold a key for. Every outcome is counted,
 * including the refusals: a deployment that only meters successes cannot see
 * itself being probed.
 */
export const handleGateway = (options: GatewayOptions, request: GatewayRequest): ApiResponse => {
  const route = routeLabel(request.path);

  if (request.apiKey === undefined) {
    options.metrics.increment('erc8415_requests_total', { route, outcome: 'unauthenticated' });
    return { status: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  const key = options.keys.authenticate(request.apiKey);
  if (key === undefined) {
    options.metrics.increment('erc8415_requests_total', { route, outcome: 'rejected' });
    return { status: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  try {
    const store = options.tenants.storeFor(key.tenantId);
    const response = handle(store, request, options.clock);
    options.metrics.increment('erc8415_requests_total', {
      tenant: key.tenantId,
      route,
      outcome: response.status < 400 ? 'ok' : 'refused',
      status: String(response.status),
    });
    return response;
  } catch (error) {
    if (error instanceof UnknownTenant) {
      options.metrics.increment('erc8415_requests_total', { route, outcome: 'unknown_tenant' });
      return { status: 403, body: { error: 'UNKNOWN_TENANT' } };
    }
    options.metrics.increment('erc8415_requests_total', { tenant: key.tenantId, route, outcome: 'error' });
    throw error;
  }
};

/**
 * A route label with the identifiers stripped out, so a metric never carries a
 * token id or an instant.
 */
const routeLabel = (path: string): string =>
  path
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? ':id' : part))
    .join('/') || 'root';
