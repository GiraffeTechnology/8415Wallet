import { createServer, type Server, type IncomingMessage } from 'node:http';
import { AccessDenied, type Directory } from '../engine/access/roles.ts';
import { ProjectionError } from '../engine/projection/errors.ts';
import { overview, timeline } from './view.ts';
import { renderOverview, renderTimeline } from './render.ts';
import type { ProjectionStore } from '../engine/projection/store.ts';
import type { SettlementEngine } from '../engine/settlement/engine.ts';
import type { Address, Instant, TokenId } from '../engine/projection/types.ts';

export interface ConsoleOptions {
  readonly store: ProjectionStore;
  readonly directory: Directory;
  readonly settlement?: SettlementEngine;
  readonly clock: { now(): Instant };
  /** Supplies the ERC-721 owner. Absent means the console shows "not read". */
  readonly ownerOf?: (tokenId: TokenId) => Address | undefined;
}

export interface ConsoleRequest {
  readonly method: string;
  readonly path: string;
  /** Authenticated user. The transport establishes it; the console enforces roles. */
  readonly user?: string;
  readonly query?: Readonly<Record<string, string>>;
}

export interface ConsoleResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const html = (status: number, body: string): ConsoleResponse => ({ status, contentType: 'text/html; charset=utf-8', body });
const text = (status: number, body: string): ConsoleResponse => ({ status, contentType: 'text/plain; charset=utf-8', body });

/**
 * The institutional console: read-only over the projection.
 *
 * There is no route here that writes to a projection, because there is no
 * method on this handler that could. Sign-in establishes who is asking; the
 * directory decides what they may read.
 */
export const handleConsole = (options: ConsoleOptions, request: ConsoleRequest): ConsoleResponse => {
  const segments = request.path.split('/').filter((part) => part.length > 0);

  if (segments.length === 0) {
    return html(200, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ERC-8415 console</title></head><body><h1>ERC-8415 console</h1><p>Sign in to read a projection.</p></body></html>');
  }

  if (request.user === undefined) return text(401, 'sign in required');
  const role = options.directory.roleOf(request.user);
  if (role === undefined) return text(403, 'this account has no role in this console');

  try {
    if (segments[0] === 'token' && segments.length === 2) {
      options.directory.require(request.user, 'projection:read');
      const tokenId = BigInt(segments[1] as string);
      const raw = request.query?.['instant'];
      const instant = raw === undefined ? options.clock.now() : BigInt(raw);
      return html(200, renderOverview(overview({
        store: options.store,
        tokenId,
        instant,
        ...(options.settlement === undefined ? {} : { settlement: options.settlement }),
        ...(options.ownerOf?.(tokenId) === undefined ? {} : { owner: options.ownerOf(tokenId) as Address }),
      })));
    }

    if (segments[0] === 'token' && segments[2] === 'timeline' && segments.length === 3) {
      options.directory.require(request.user, 'audit:read');
      const tokenId = BigInt(segments[1] as string);
      const settlements = options.store.settlementsFor(tokenId);
      return html(200, renderTimeline(tokenId.toString(), timeline(options.store.entries(tokenId), settlements)));
    }

    if (segments[0] === 'permissions' && segments.length === 1) {
      options.directory.require(request.user, 'permissions:manage');
      const rows = options.directory.users()
        .map((item) => `<tr><td>${item.user}</td><td>${item.role}</td></tr>`)
        .join('');
      return html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Permissions</title></head><body><h1>Permissions</h1><table>${rows}</table></body></html>`);
    }
  } catch (error) {
    if (error instanceof AccessDenied) return text(403, error.message);
    if (error instanceof ProjectionError) return text(404, error.message);
    if (error instanceof SyntaxError) return text(400, 'malformed token id or instant');
    throw error;
  }

  return text(404, 'not found');
};

export interface ConsoleServerOptions extends ConsoleOptions {
  /** Verify a session or credential and return its subject; never trust a user header. */
  readonly authenticate: (request: IncomingMessage) => string | undefined | Promise<string | undefined>;
}

export const createConsole = (options: ConsoleServerOptions): Server => {
  if (typeof options.authenticate !== 'function') throw new Error('console authentication is required');
  const authenticate = options.authenticate;
  return createServer(async (incoming, outgoing) => {
    let user: string | undefined;
    try {
      user = await authenticate(incoming);
    } catch {
      outgoing.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('sign in required');
      return;
    }
    const url = new URL(incoming.url ?? '/', 'http://console.invalid');
    const response = handleConsole(options, {
      method: incoming.method ?? 'GET',
      path: url.pathname,
      ...(typeof user === 'string' ? { user } : {}),
      query: Object.fromEntries(url.searchParams),
    });
    outgoing.writeHead(response.status, { 'content-type': response.contentType });
    outgoing.end(response.body);
  });
};
