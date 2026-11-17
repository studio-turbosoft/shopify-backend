import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ShopifySession } from '../auth/shopify-session.guard';
import { ShopifyAuthService } from './shopify-auth.service';

/** Admin API version used when SHOPIFY_API_VERSION isn't set. Shopify supports each for about a year. */
const DEFAULT_API_VERSION = '2026-10';

/**
 * Readable message for an ACCESS_DENIED error. Shopify's message names the scope, e.g.
 * "Access denied for productSet field. Required access: `write_products` access scope."
 */
export function missingScopeMessage(reason: string): string {
  const scopes = [...new Set([...reason.matchAll(/`(\w+)` access scope/g)].map((m) => m[1]))];
  const which = scopes.length ? `the ${scopes.join(' / ')} scope` : 'a scope it does not have';
  return (
    `Shopify denied access: the app needs ${which}. Add it under Access scopes in the app's version ` +
    `in the Shopify Dev Dashboard, release the version, then open the app in the store to approve it. ` +
    `(Shopify: ${reason})`
  );
}

/** Calls the Shopify Admin GraphQL API for the store in the session. */
@Injectable()
export class ShopifyAdminService {
  constructor(
    private readonly auth: ShopifyAuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Run a GraphQL query or mutation and return its `data`.
   * If Shopify rejects the saved token (401), get a fresh one and try once more.
   */
  async graphql<T>(session: ShopifySession, query: string, variables?: Record<string, unknown>): Promise<T> {
    let res = await this.post(session, await this.auth.getAccessToken(session), query, variables);
    if (res.status === 401) {
      await this.auth.forget(session.shop);
      res = await this.post(session, await this.auth.exchange(session), query, variables);
    }

    const body = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[] | string;
    } | null;

    if (!res.ok || !body || body.errors) {
      const errors = body?.errors;
      const reason = Array.isArray(errors) ? errors.map((e) => e.message).join('; ') : errors || `HTTP ${res.status}`;
      const accessDenied =
        res.status === 403 ||
        (Array.isArray(errors) && errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) ||
        /access denied/i.test(reason);
      throw new BadGatewayException(accessDenied ? missingScopeMessage(reason) : `Shopify Admin API error: ${reason}`);
    }
    return body.data as T;
  }

  private post(session: ShopifySession, accessToken: string, query: string, variables?: Record<string, unknown>) {
    const version = this.config.get<string>('SHOPIFY_API_VERSION') ?? DEFAULT_API_VERSION;
    return fetch(`https://${session.shop}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables }),
    });
  }
}
