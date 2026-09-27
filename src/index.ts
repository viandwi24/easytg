// Public API. Everything exported here is covered by semver; keep it small.
export {
  EasyTG,
  type EasyTGOptions,
  type EasyTGEvents,
  type SessionOptions,
  type ButtonsOptions,
  type DeepLinksOptions,
  type DialoguesOptions,
  type I18nOptions,
  type OpenOptions,
  type BroadcastOptions,
  type EditMessageTarget,
} from './engine';
export { page, dialogue, withContext, type Page, type Dialogue } from './define';
export { replyMenu, type ReplyMenu, type MenuButton, type MenuLabel, type ReplyMenuOptions } from './menu';
export type { Nav } from './nav';
export type { Session, SessionSetOptions } from './session';
export {
  md,
  html,
  escapeMarkdown,
  escapeMarkdownV2,
  escapeHTML,
  type Formatted,
  type ParseMode,
  type TextInput,
  type TextPart,
} from './format';
export { paginate, type PaginateOptions, type Pagination } from './pagination';
export { isProactive, type SendTarget } from './proactive';
export type { BroadcastProgress, BroadcastResult, BroadcastSettings } from './broadcast';
export { MemoryStorage, withPrefix, type StorageAdapter } from './storage';
export { defaultTexts, type EasyTGTexts } from './texts';
export type { Logger } from './logger';
export { EasyTGError, InvalidParamsError, isBlockedByUser, isMessageNotFound, retryAfter } from './errors';
export type { AntiSpamOptions, SpamEvent } from './antispam';
export type { CallbackParamsMode } from './callback-store';
export type { ParamValue, ParamsInput } from './callback';
export type { DeliveryResult } from './render';
export type {
  Redirect,
  DialogueStart,
  Awaitable,
  ButtonOptions,
  Collected,
  DeliveryMode,
  DialogueContact,
  DialogueEndArgs,
  DialogueFile,
  DialogueLocation,
  DialogueStep,
  FileKind,
  AlbumItem,
  CopySource,
  MediaFields,
  MediaSource,
  MediaType,
  KeyboardInput,
  KeyboardRow,
  Middleware,
  MiddlewareArgs,
  PageContent,
  Params,
  ParamsShape,
  RenderArgs,
  RenderResult,
  StepAction,
  StepHelpers,
  ValidateResult,
} from './types';
