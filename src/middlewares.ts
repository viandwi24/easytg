import type { Context } from 'grammy';
import type { Middleware } from './types';

export interface RequireChatAdminOptions {
  /** How long a user's admin status is remembered, per chat. Default 5 minutes. */
  cacheMs?: number;
  /** Also require this admin right, e.g. `can_restrict_members`. */
  right?: string;
}

/**
 * A middleware that lets only chat admins (and the owner) through in groups;
 * private chats pass. Others get the `adminOnly` toast on button presses.
 *
 *   page('settings').use(requireChatAdmin()).render(...)
 *   dialogue('ban').use(requireChatAdmin({ right: 'can_restrict_members' }))
 */
export function requireChatAdmin<C extends Context = Context>(options: RequireChatAdminOptions = {}): Middleware<C> {
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  const cache = new Map<string, { admin: boolean; until: number }>();

  const isAdmin = async (ctx: C, chatId: number, userId: number) => {
    const key = `${ctx.me.id}:${chatId}:${userId}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.until > now) return hit.admin;
    const member = await ctx.api.getChatMember(chatId, userId);
    const admin =
      member.status === 'creator' ||
      (member.status === 'administrator' && (!options.right || (member as unknown as Record<string, unknown>)[options.right] === true));
    if (cache.size > 10_000) for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
    cache.set(key, { admin, until: now + cacheMs });
    return admin;
  };

  return async ({ ctx, app }, next) => {
    const chat = ctx.chat;
    const userId = ctx.from?.id;
    if (!chat || chat.type === 'private' || chat.type === 'channel') return next();
    if (userId !== undefined && (await isAdmin(ctx, chat.id, userId))) return next();
    return ctx.callbackQuery ? { toast: { text: app.textsFor(ctx).adminOnly, alert: true } } : undefined;
  };
}
