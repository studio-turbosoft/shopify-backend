import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ShopifySession } from './shopify-session.guard';

/**
 * The verified Shopify session for this request (set by ShopifySessionGuard).
 * Use on routes that need to know the store, e.g. to call the Admin API:
 *   @Get() find(@CurrentSession() session: ShopifySession) {}
 *
 * Throws 401 when there is none: with SHOPIFY_AUTH=off the guard lets requests through
 * without a session, but these routes can't work without a real store.
 */
export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext): ShopifySession => {
  const session = ctx.switchToHttp().getRequest().shopifySession as ShopifySession | undefined;
  if (!session) {
    throw new UnauthorizedException('This route needs a Shopify session: open the app inside the Shopify admin');
  }
  return session;
});
