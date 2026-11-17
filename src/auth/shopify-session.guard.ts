import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a verified Shopify session token tells us about the caller. */
export interface ShopifySession {
  /** e.g. "my-store.myshopify.com" */
  shop: string;
  /** The verified session token itself; token exchange swaps it for an Admin API access token. */
  token: string;
}

/** Clock difference allowed between Shopify and this server, in seconds. */
const CLOCK_SKEW = 10;

/**
 * Verifies the Shopify session token that App Bridge sends as `Authorization: Bearer <token>`.
 *
 * The token is a JWT signed (HS256) with the app's client secret. A valid token proves the request
 * came from this app running inside a real store's admin. Checks:
 *  - signature matches SHOPIFY_API_SECRET
 *  - `aud` is this app's client ID (SHOPIFY_API_KEY)
 *  - not expired / not used before `nbf`
 *  - `iss` and `dest` point at the same *.myshopify.com shop
 *
 * Local development (outside the Shopify admin, no token): set SHOPIFY_AUTH=off to let requests
 * without a token through. Tokens that are sent are still verified. Never set that on the server.
 */
@Injectable()
export class ShopifySessionGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    if (!token) {
      // Local dev: allow requests without a token. A token that IS sent is still checked below,
      // so the app also works from inside the Shopify admin in dev mode.
      if (this.config.get('SHOPIFY_AUTH') === 'off') return true;
      throw new UnauthorizedException('Missing Shopify session token');
    }

    req.shopifySession = this.verify(token);
    return true;
  }

  private verify(token: string): ShopifySession {
    const secret = this.config.get<string>('SHOPIFY_API_SECRET');
    const apiKey = this.config.get<string>('SHOPIFY_API_KEY');
    if (!secret || !apiKey) {
      // Fail closed: a misconfigured server must not accept every request.
      throw new UnauthorizedException('Server is missing SHOPIFY_API_KEY / SHOPIFY_API_SECRET');
    }

    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Malformed session token');
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = this.decode(headerB64);
    if (header?.alg !== 'HS256') throw new UnauthorizedException('Unsupported token algorithm');

    const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
    const actual = Buffer.from(signatureB64, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException('Invalid session token signature');
    }

    const p = this.decode(payloadB64);
    const now = Math.floor(Date.now() / 1000);
    if (typeof p?.exp !== 'number' || now > p.exp + CLOCK_SKEW) {
      throw new UnauthorizedException('Session token expired');
    }
    if (typeof p.nbf === 'number' && now + CLOCK_SKEW < p.nbf) {
      throw new UnauthorizedException('Session token not yet valid');
    }
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(apiKey)) throw new UnauthorizedException('Session token is for another app');

    const shop = this.shopFrom(p.dest);
    if (!shop || this.shopFrom(p.iss) !== shop) {
      throw new UnauthorizedException('Session token shop mismatch');
    }

    return { shop, token };
  }

  private decode(part: string): any {
    try {
      return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Malformed session token');
    }
  }

  /** "https://my-store.myshopify.com/admin" → "my-store.myshopify.com" (null if not a shop URL) */
  private shopFrom(url: unknown): string | null {
    if (typeof url !== 'string') return null;
    try {
      const host = new URL(url).hostname;
      return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(host) ? host.toLowerCase() : null;
    } catch {
      return null;
    }
  }
}
