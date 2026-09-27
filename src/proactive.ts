import { Context, type Api } from 'grammy';
import type { Chat, Update, User, UserFromGetMe } from 'grammy/types';

export interface SendTarget {
  chatId: number;
  /** The user this is for (owner of the menu, whose user context is used). Defaults to `chatId` for private chats. */
  userId?: number;
  /** Forum topic to post in. */
  threadId?: number;
}

const PROACTIVE = Symbol('easytg.proactive');

/**
 * A context for rendering outside of an update (notifications, cron jobs,
 * webhooks). It only has `api`, `me`, `chat` and `from`; there is no message,
 * callback query or plugin state, and properties added by your own
 * middlewares are missing.
 */
class ProactiveContext extends Context {
  readonly [PROACTIVE] = true;

  constructor(
    api: Api,
    me: UserFromGetMe,
    private readonly target: { chat: Chat; from?: User; threadId?: number },
  ) {
    super({ update_id: 0 } as Update, api, me);
  }

  override get chat(): Chat {
    return this.target.chat;
  }

  override get from(): User | undefined {
    return this.target.from;
  }

  override reply(...[text, other, signal]: Parameters<Context['reply']>) {
    return super.reply(text, { message_thread_id: this.target.threadId, ...other }, signal);
  }

  override replyWithPhoto(...[photo, other, signal]: Parameters<Context['replyWithPhoto']>) {
    return super.replyWithPhoto(photo, { message_thread_id: this.target.threadId, ...other }, signal);
  }
}

export function createProactiveContext(api: Api, me: UserFromGetMe, target: SendTarget): Context {
  const privateChat = target.chatId > 0;
  const userId = target.userId ?? (privateChat ? target.chatId : undefined);
  const chat = (privateChat
    ? { id: target.chatId, type: 'private', first_name: '' }
    : { id: target.chatId, type: 'supergroup', title: '' }) as Chat;
  const from = userId === undefined ? undefined : { id: userId, is_bot: false, first_name: '' };
  return new ProactiveContext(api, me, { chat, from, threadId: target.threadId });
}

/** True when a page is being rendered by `app.sendTo` rather than an update. */
export function isProactive(ctx: Context): boolean {
  return (ctx as any)[PROACTIVE] === true;
}
