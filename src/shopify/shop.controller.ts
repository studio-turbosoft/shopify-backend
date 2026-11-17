import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentSession } from '../auth/current-session.decorator';
import { ShopifySessionGuard, type ShopifySession } from '../auth/shopify-session.guard';
import { ShopifyAdminService } from './shopify-admin.service';

const SHOP_QUERY = `#graphql
  query ShopInfo {
    shop {
      name
      myshopifyDomain
      plan { displayName }
      currencyCode
    }
    currentAppInstallation {
      accessScopes { handle }
    }
  }`;

interface ShopInfo {
  shop: { name: string; myshopifyDomain: string; plan: { displayName: string }; currencyCode: string };
  currentAppInstallation: { accessScopes: { handle: string }[] };
}

// GET /api/shop: the store this request comes from, read live from the Admin API.
// Proves the whole chain: session token → access token → Admin API call.
@UseGuards(ShopifySessionGuard)
@Controller('shop')
export class ShopController {
  constructor(private readonly admin: ShopifyAdminService) {}

  @Get()
  async info(@CurrentSession() session: ShopifySession) {
    const data = await this.admin.graphql<ShopInfo>(session, SHOP_QUERY);
    return {
      name: data.shop.name,
      domain: data.shop.myshopifyDomain,
      plan: data.shop.plan.displayName,
      currency: data.shop.currencyCode,
      scopes: data.currentAppInstallation.accessScopes.map((s) => s.handle),
    };
  }
}
