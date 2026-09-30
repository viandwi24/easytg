/**
 * `/commands` bound to pages and dialogues, and the list Telegram shows in
 * its command menu (`setMyCommands`), kept in step with the code.
 */
import type { BotCommand, BotCommandScope, Message } from 'grammy/types';
import { EasyTGError } from './errors';
import type { Translate } from './i18n';
import type { ParamsInput } from './callback';

/** Where a command works and is listed. */
export type CommandChats = 'all' | 'private' | 'groups';

export interface CommandOptions {
  /**
   * Shown in Telegram's command menu (1–256 characters). A function gets the
   * language, for translated menus. Without it the command works but isn't
   * listed.
   */
  description?: string | ((locale: string | undefined, t: Translate) => string);
  /** `all` (default), `private` chats only, or `groups` only. Elsewhere the command is passed on to your handlers. */
  chats?: CommandChats;
  /** Params for the page or dialogue from the text after the command: `/find tea` gives `'tea'`. */
  params?: (args: string) => ParamsInput;
}

export interface CommandEntry<T> {
  name: string;
  target: T;
  options: CommandOptions;
}

const NAME = /^[a-z0-9_]{1,32}$/;
const SCOPES: Record<CommandChats, BotCommandScope> = {
  all: { type: 'default' },
  private: { type: 'all_private_chats' },
  groups: { type: 'all_group_chats' },
};

export class Commands<T> {
  private readonly entries = new Map<string, CommandEntry<T>>();

  add(names: string | string[], target: T, options: CommandOptions) {
    for (const raw of Array.isArray(names) ? names : [names]) {
      const name = raw.replace(/^\//, '');
      if (!NAME.test(name)) throw new EasyTGError(`Invalid command "${raw}": 1–32 lowercase letters, digits or underscores`);
      if (this.entries.has(name)) throw new EasyTGError(`Command "/${name}" is already defined`);
      const description = options.description;
      if (typeof description === 'string' && (description.length < 1 || description.length > 256)) {
        throw new EasyTGError(`The description of "/${name}" must be 1–256 characters`);
      }
      this.entries.set(name, { name, target, options });
    }
  }

  get size() {
    return this.entries.size;
  }

  /** The command a message starts with, if it is one of ours (and for this bot and chat type). */
  match(message: Message | undefined, botUsername: string | undefined): { entry: CommandEntry<T>; args: string } | undefined {
    const text = message?.text;
    const first = message?.entities?.[0];
    if (!text || first?.type !== 'bot_command' || first.offset !== 0) return undefined;
    const [command, mention] = text.slice(1, first.length).split('@');
    if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return undefined;
    const entry = this.entries.get(command!.toLowerCase());
    if (!entry) return undefined;
    const group = message!.chat.type === 'group' || message!.chat.type === 'supergroup';
    const chats = entry.options.chats ?? 'all';
    if ((chats === 'private' && message!.chat.type !== 'private') || (chats === 'groups' && !group)) return undefined;
    return { entry, args: text.slice(first.length).trim() };
  }

  /** Whether any description depends on the language. */
  get translated() {
    return [...this.entries.values()].some((e) => typeof e.options.description === 'function');
  }

  /**
   * The command lists per scope, as Telegram picks them: a private chat sees
   * the private-chats list if there is one, else the default list; groups
   * likewise. So the narrower lists repeat the commands for all chats. A
   * scope without commands of its own gets `null`: delete its list.
   */
  lists(locale: string | undefined, t: Translate): { scope: BotCommandScope; commands: BotCommand[] | null }[] {
    const listed = (chats: CommandChats[]) =>
      [...this.entries.values()]
        .filter((e) => e.options.description !== undefined && chats.includes(e.options.chats ?? 'all'))
        .map((e) => {
          const d = e.options.description!;
          return { command: e.name, description: (typeof d === 'function' ? d(locale, t) : d).slice(0, 256) || e.name };
        });
    const has = (chats: CommandChats) => [...this.entries.values()].some((e) => e.options.description !== undefined && (e.options.chats ?? 'all') === chats);
    return [
      { scope: SCOPES.all, commands: listed(['all']) },
      { scope: SCOPES.private, commands: has('private') ? listed(['all', 'private']) : null },
      { scope: SCOPES.groups, commands: has('groups') ? listed(['all', 'groups']) : null },
    ];
  }
}
