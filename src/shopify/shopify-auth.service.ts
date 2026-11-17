import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { ShopifySession } from '../auth/shopify-session.guard';

/**
 * Gets each store's Admin API access token via token exchange:
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
 *
 * The first request from a store swaps its session token for an offline access token,
 * which is saved in the `shops` table and reused after that.
 */
@Injectable()
export class ShopifyAuthService {
  private readonly logger = new Logger(ShopifyAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** The saved access token for this store, or a new one from token exchange. */
  async getAccessToken(session: ShopifySession): Promise<string> {
    return (await this.getSavedToken(session.shop)) ?? this.exchange(session);
  }

  /** The saved offline token, or null (used where no session token can be exchanged, e.g. webhooks). */
  async getSavedToken(shop: string): Promise<string | null> {
    const saved = await this.prisma.shop.findUnique({ where: { domain: shop } });
    return saved?.accessToken ?? null;
  }

  /** Swap the session token for an offline access token and save it. */
  async exchange(session: ShopifySession): Promise<string> {
    // session.shop was validated by the guard (*.myshopify.com), so this URL is safe to call.
    const res = await fetch(`https://${session.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.config.getOrThrow<string>('SHOPIFY_API_KEY'),
        client_secret: this.config.getOrThrow<string>('SHOPIFY_API_SECRET'),
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: session.token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      }),
    });

    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    } | null;

    if (!res.ok || !body?.access_token) {
      const reason = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
      this.logger.warn(`Token exchange failed for ${session.shop}: ${reason}`);
      throw new BadGatewayException(`Shopify token exchange failed: ${reason}`);
    }

    await this.prisma.shop.upsert({
      where: { domain: session.shop },
      create: { domain: session.shop, accessToken: body.access_token, scope: body.scope ?? null },
      update: { accessToken: body.access_token, scope: body.scope ?? null },
    });
    this.logger.log(`Saved access token for ${session.shop} (scopes: ${body.scope ?? 'none'})`);
    return body.access_token;
  }

  /** Drop a saved token Shopify no longer accepts (e.g. the app was reinstalled). */
  async forget(shop: string): Promise<void> {
    await this.prisma.shop.deleteMany({ where: { domain: shop } });
  }
}
