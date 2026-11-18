import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ShopifySession } from '../auth/shopify-session.guard';
import { ShopifyAuthService } from './shopify-auth.service';

/** Admin API version used when SHOPIFY_API_VERSION isn't set. Shopify supports each for about a year. */
const DEFAULT_API_VERSION = '2026-10';

/** How often a throttled request is retried before giving up. */
const MAX_THROTTLE_RETRIES = 5;
const MAX_THROTTLE_WAIT_MS = 30_000;

/**
 * Readable message for an ACCESS_DENIED error. Shopify's message names the scope, e.g.
 * "Access denied for productSet field. Required access: `write_products` access scope."
 */
function missingScopeMessage(reason: string): string {
  const scopes = [...new Set([...reason.matchAll(/`(\w+)` access scope/g)].map((m) => m[1]))];
  const which = scopes.length ? `the ${scopes.join(' / ')} scope` : 'a scope it does not have';
  return (
    `Shopify denied access: the app needs ${which}. Add it under Access scopes in the app's version ` +
    `in the Shopify Dev Dashboard, release the version, then open the app in the store to approve it. ` +
    `(Shopify: ${reason})`
  );
}

interface GraphqlBody<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[] | string;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number };
    };
  };
}

/**
 * How long to wait before retrying a throttled request, or null if it wasn't throttled.
 * GraphQL Admin rate limits are cost based: a throttled query gets HTTP 200 with a THROTTLED error
 * and `extensions.cost.throttleStatus`; we wait until enough points are restored for the query.
 * https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
 */
function throttleDelayMs(status: number, retryAfter: string | null, body: GraphqlBody<unknown> | null): number | null {
  if (status === 429) {
    const seconds = Number(retryAfter);
    return Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000, MAX_THROTTLE_WAIT_MS);
  }
  const errors = body?.errors;
  if (!Array.isArray(errors) || !errors.some((e) => e.extensions?.code === 'THROTTLED')) return null;
  const cost = body?.extensions?.cost;
  const needed = (cost?.requestedQueryCost ?? 0) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
  const rate = cost?.throttleStatus?.restoreRate ?? 0;
  const ms = rate > 0 && needed > 0 ? Math.ceil(needed / rate) * 1000 : 1000;
  return Math.min(Math.max(ms, 1000), MAX_THROTTLE_WAIT_MS);
}

/** The response body as JSON, or null if it isn't JSON. */
function readBody<T>(res: Response): Promise<GraphqlBody<T> | null> {
  return res.json().catch(() => null) as Promise<GraphqlBody<T> | null>;
}

/** The error to throw for a failed Admin API call (names the missing scope on ACCESS_DENIED). */
function shopifyError(status: number, errors: GraphqlBody<unknown>['errors']): BadGatewayException {
  const reason = Array.isArray(errors) ? errors.map((e) => e.message).join('; ') : errors || `HTTP ${status}`;
  const accessDenied =
    status === 403 ||
    (Array.isArray(errors) && errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) ||
    /access denied/i.test(reason);
  return new BadGatewayException(accessDenied ? missingScopeMessage(reason) : `Shopify Admin API error: ${reason}`);
}

/** The shop has no saved access token (never opened the app, or uninstalled it). */
export class ShopNotConnectedError extends Error {
  constructor(
    readonly shop: string,
    reason = 'no saved access token (open the app in the store once)',
  ) {
    super(`${shop}: ${reason}`);
  }
}

/** Where a call gets its access token, and what to do when Shopify rejects it (401). */
interface TokenSource {
  get(): Promise<string>;
  /** Returns a new token to retry with, or throws. */
  refresh(): Promise<string>;
}

/** Calls the Shopify Admin GraphQL API for a store. */
@Injectable()
export class ShopifyAdminService {
  private readonly logger = new Logger(ShopifyAdminService.name);

  constructor(
    private readonly auth: ShopifyAuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Run a GraphQL query or mutation for the store in the session and return its `data`.
   * If Shopify rejects the saved token (401), get a fresh one by token exchange and try once more.
   */
  async graphql<T>(session: ShopifySession, query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.execute<T>(session.shop, query, variables, {
      get: () => this.auth.getAccessToken(session),
      refresh: async () => {
        await this.auth.forget(session.shop);
        return this.auth.exchange(session);
      },
    });
  }

  /**
   * Same as graphql(), but with the shop's SAVED offline token, for work that has no session
   * (webhooks). There is no session token to exchange, so a shop without a saved token, or whose
   * token Shopify rejects, throws ShopNotConnectedError. `shop` must be a validated *.myshopify.com domain.
   */
  async graphqlForShop<T>(shop: string, query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.execute<T>(shop, query, variables, {
      get: async () => {
        const token = await this.auth.getSavedToken(shop);
        if (!token) throw new ShopNotConnectedError(shop);
        return token;
      },
      refresh: async () => {
        await this.auth.forget(shop);
        throw new ShopNotConnectedError(shop, 'Shopify rejected the saved access token (it was removed)');
      },
    });
  }

  private async execute<T>(
    shop: string,
    query: string,
    variables: Record<string, unknown> | undefined,
    tokens: TokenSource,
  ): Promise<T> {
    let token = await tokens.get();
    let res = await this.post(shop, token, query, variables);
    if (res.status === 401) {
      token = await tokens.refresh();
      res = await this.post(shop, token, query, variables);
    }

    let body = await readBody<T>(res);

    // Throttled: wait and resend. Throttled requests aren't executed, so this is safe for mutations too.
    for (let attempt = 1; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
      const wait = throttleDelayMs(res.status, res.headers.get('retry-after'), body);
      if (wait === null) break;
      this.logger.warn(`Shopify throttled a request for ${shop}; retrying in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      res = await this.post(shop, token, query, variables);
      body = await readBody<T>(res);
    }

    if (!res.ok || !body || body.errors) throw shopifyError(res.status, body?.errors);
    return body.data as T;
  }

  private post(shop: string, accessToken: string, query: string, variables?: Record<string, unknown>) {
    const version = this.config.get<string>('SHOPIFY_API_VERSION') ?? DEFAULT_API_VERSION;
    return fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables }),
    });
  }
}
