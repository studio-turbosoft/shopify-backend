import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ShopifySession } from './shopify-session.guard';

/**
 * The verified Shopify session for this request, or undefined when there is none.
 * Unlike @CurrentSession() it never throws, so the route also works locally with
 * SHOPIFY_AUTH=off and no token (callers then skip the Shopify side of the work).
 */
export const OptionalSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ShopifySession | undefined =>
    ctx.switchToHttp().getRequest().shopifySession as ShopifySession | undefined,
);
