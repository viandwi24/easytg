import { Context, type Api } from 'grammy';
import type { Chat, Update, User, UserFromGetMe } from 'grammy/types';

export interface SendTarget {
  chatId: number;
  /** The user this is for (owner of the menu, whose session is used). Defaults to `chatId` for private chats. */
  userId?: number;
  /** Forum topic to post in. */
  threadId?: number;
  /**
   * In groups: the users allowed to press this message's buttons (checked like
   * menu ownership). Default: only `userId`, or anyone when there is no `userId`.
   */
  allowedUsers?: number[];
}

const PROACTIVE = Symbol('easytg.proactive');

interface ProactiveTarget {
  chat: Chat;
  from?: User;
  threadId?: number;
  allowedUsers?: number[];
}

/**
 * A context for rendering outside of an update (notifications, cron jobs,
 * webhooks). It only has `api`, `me`, `chat` and `from` (with just the user
 * id); there is no message or callback query. Use the `prepareProactive`
 * option to add what your middlewares normally put on `ctx`.
 */
class ProactiveContext extends Context {
  readonly [PROACTIVE]: ProactiveTarget;

  constructor(api: Api, me: UserFromGetMe, target: ProactiveTarget) {
    super({ update_id: 0 } as Update, api, me);
    this[PROACTIVE] = target;
  }

  override get chat(): Chat {
    return this[PROACTIVE].chat;
  }

  override get from(): User | undefined {
    return this[PROACTIVE].from;
  }

  private thread<T extends object | undefined>(other: T) {
    return { message_thread_id: this[PROACTIVE].threadId, ...other };
  }

  override reply(...[text, other, signal]: Parameters<Context['reply']>) {
    return super.reply(text, this.thread(other), signal);
  }
  override replyWithPhoto(...[file, other, signal]: Parameters<Context['replyWithPhoto']>) {
    return super.replyWithPhoto(file, this.thread(other), signal);
  }
  override replyWithVideo(...[file, other, signal]: Parameters<Context['replyWithVideo']>) {
    return super.replyWithVideo(file, this.thread(other), signal);
  }
  override replyWithAnimation(...[file, other, signal]: Parameters<Context['replyWithAnimation']>) {
    return super.replyWithAnimation(file, this.thread(other), signal);
  }
  override replyWithDocument(...[file, other, signal]: Parameters<Context['replyWithDocument']>) {
    return super.replyWithDocument(file, this.thread(other), signal);
  }
  override replyWithAudio(...[file, other, signal]: Parameters<Context['replyWithAudio']>) {
    return super.replyWithAudio(file, this.thread(other), signal);
  }
  override replyWithRichMessage(...[rich, other, signal]: Parameters<Context['replyWithRichMessage']>) {
    return super.replyWithRichMessage(rich, this.thread(other), signal);
  }
  override replyWithMediaGroup(...[media, other, signal]: Parameters<Context['replyWithMediaGroup']>) {
    return super.replyWithMediaGroup(media, this.thread(other), signal);
  }
}

export function createProactiveContext(api: Api, me: UserFromGetMe, target: SendTarget): Context {
  const privateChat = target.chatId > 0;
  const userId = target.userId ?? (privateChat ? target.chatId : undefined);
  const chat = (privateChat
    ? { id: target.chatId, type: 'private', first_name: '' }
    : { id: target.chatId, type: 'supergroup', title: '' }) as Chat;
  const from = userId === undefined ? undefined : { id: userId, is_bot: false, first_name: '' };
  return new ProactiveContext(api, me, { chat, from, threadId: target.threadId, allowedUsers: target.allowedUsers });
}

/** True when a page is being rendered by `app.sendTo` / `app.edit` / `app.broadcast` rather than an update. */
export function isProactive(ctx: Context): boolean {
  return PROACTIVE in ctx;
}

/** @internal Forum topic to post in: the proactive target's, or the incoming message's. */
export function threadIdOf(ctx: Context): number | undefined {
  if (PROACTIVE in ctx) return (ctx as ProactiveContext)[PROACTIVE].threadId;
  return ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined;
}

/** @internal `allowedUsers` of a proactive target. */
export function allowedUsersOf(ctx: Context): number[] | undefined {
  return PROACTIVE in ctx ? (ctx as ProactiveContext)[PROACTIVE].allowedUsers : undefined;
}
