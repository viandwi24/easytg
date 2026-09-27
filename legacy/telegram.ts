import type { InlineKeyboardButton } from '@grammyjs/types';
import { Api, Bot, Context, InlineKeyboard, InputFile, type RawApi,  } from 'grammy';
// import { gzipSync, gunzipSync } from 'fflate';
import { Buffer } from 'buffer';
import { convert as MarkdownV2Escape } from 'telegram-markdown-v2';
import { logger } from './logger';

export type PageRenderContent = {
  text?: string | string[];
  inline_keyboard?: InlineKeyboardButton[][];
}

export type PageRenderFunction = (page: Page, params: Record<string, string>, uctx: Awaited<ReturnType<TemplateEngine['getUserContext']>>, context: Context) => Promise<PageRenderContent|Dialogue|undefined>;

export type PageMiddleware = (next: PageRenderFunction, page: Page, params: Record<string, string>, uctx: Awaited<ReturnType<TemplateEngine['getUserContext']>>, context: Context) => Promise<PageRenderContent|Dialogue|undefined>;

export interface PageRenderParams {
  id: string;
  render: PageRenderFunction;
  middlewares?: PageMiddleware[];
}

export class Page {
  constructor(public template: TemplateEngine, public params: PageRenderParams) {}

  createButtonNav(text: string, pageId: string, params: object = {}) {
    const data = this.template.createQueryInlineData(pageId, params);
    // console.log('createButtonNav', { text, pageId, params, data });
    return InlineKeyboard.text(text, data);
  }

  createButtonBackToHome(text: string = '🏠 Beranda') {
    return this.createButtonNav(text, 'home');
  }

  createButtonBack(to: string, params: Record<string, string> = {}, text: string = '↩️ Kembali') {
    return this.createButtonNav(text, to, params);
  }

  createButtonClose(text: string = '❌ Tutup') {
    return InlineKeyboard.text(text, `p|exit|_dc=true`);
  }

  createButtonUrl(text: string, url: string) {
    return InlineKeyboard.url(text, url);
  }

  createButtonWebApp(text: string, url: string) {
    return InlineKeyboard.webApp(text, url);
  }

  async buildFromCommand(params: Record<string, string> = {}, ctx: Context) {
    const uctx = await this.template.getUserContext(ctx);

    const run = (...args: Parameters<PageRenderFunction>) => this.params.render(...args);
    let content: PageRenderContent | Dialogue | undefined;

    // Combine global middlewares + page-specific middlewares
    // Global middlewares run FIRST (outermost), then page middlewares
    const globalMiddlewares = this.template.globalMiddlewares || [];
    const pageMiddlewares = this.params.middlewares || [];
    const allMiddlewares = [...globalMiddlewares, ...pageMiddlewares];

    const composed = allMiddlewares.reduceRight(
      (next, mw) => {
        return (...args: Parameters<PageRenderFunction>) => mw(next, ...args);
      },
      run
    );
    // logger.debug(`[TPL] buildFromCommand: Calling render for page ${this.params.id}`);
    content = await composed(this, params, uctx, ctx);
    // logger.debug(`[TPL] buildFromCommand: Render completed for page ${this.params.id}`);

    if (!content) {
      // logger.debug(`[TPL] buildFromCommand: No content returned for page ${this.params.id}`);
      return;
    }
    if (content instanceof Dialogue) {
      // logger.debug(`[TPL] buildFromCommand: Content is Dialogue, closing for page ${this.params.id}`);
      await this.close(ctx);
      return;
    }
    const text = content.text ? Array.isArray(content.text) ? content.text.join('\n') : content.text : '';
    // logger.debug(`[TPL] buildFromCommand: Sending reply for page ${this.params.id}, text length: ${text.length}`);

    const replyPromise = ctx.reply(
      MarkdownV2Escape(text, 'escape'),
      {
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
        reply_markup: {
          inline_keyboard: content.inline_keyboard || [],
        },
        parse_mode: 'MarkdownV2',
      }
    );

    // Add timeout protection for ctx.reply
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ctx.reply timeout after 25s')), 25000)
    );

    try {
      const result = await Promise.race([replyPromise, timeoutPromise]);
      // logger.debug(`[TPL] buildFromCommand: Reply sent successfully for page ${this.params.id}`);
      return result;
    } catch (error) {
      logger.error(`[TPL] buildFromCommand: Reply failed for page ${this.params.id}:`, error);
      throw error;
    }
  }

  async buildFromCallbackQuery(ctx: Context, params: Record<string, string>) {
    logger.debug(`[Page.buildFromCallbackQuery] START - pageId: ${this.params.id}, params:`, params);
    const uctx = await this.template.getUserContext(ctx);
    // const content = await this.params.render(this, params, uctx, ctx);

    const run = (...args: Parameters<PageRenderFunction>) => this.params.render(...args);
    let content: PageRenderContent | Dialogue | undefined;

    // Combine global middlewares + page-specific middlewares
    // Global middlewares run FIRST (outermost), then page middlewares
    const globalMiddlewares = this.template.globalMiddlewares || [];
    const pageMiddlewares = this.params.middlewares || [];
    const allMiddlewares = [...globalMiddlewares, ...pageMiddlewares];

    // logger.debug(`[Page.buildFromCallbackQuery] Running ${allMiddlewares.length} middlewares + render`);

    const composed = allMiddlewares.reduceRight(
      (next, mw) => {
        return (...args: Parameters<PageRenderFunction>) => mw(next, ...args);
      },
      run
    );
    content = await composed(this, params, uctx, ctx);

    // logger.debug(`[Page.buildFromCallbackQuery] Content type: ${content instanceof Dialogue ? 'Dialogue' : typeof content}`);

    if (!content) {
      logger.debug(`[Page.buildFromCallbackQuery] No content returned, exiting`);
      return;
    }
    if (content instanceof Dialogue) {
      await this.close(ctx);
      return;
    }
    const text = content.text ? Array.isArray(content.text) ? content.text.join('\n') : content.text : undefined;
    if (!text && !content.inline_keyboard) return;

    // Smart photo message handling
    const oldMessage = ctx.callbackQuery?.message;
    const oldMessageHasPhoto = oldMessage && 'photo' in oldMessage;
    const newMessageImage = (content as any).image;
    const newMessageHasPhoto = !!newMessageImage;

    try {
      // Case 1: Old has photo, new has photo
      if (oldMessageHasPhoto && newMessageHasPhoto) {
        // Check if same photo (by file_id)
        const oldPhotoFileId = oldMessage.photo && oldMessage.photo[oldMessage.photo.length - 1]?.file_id;
        const newPhotoFileId = typeof newMessageImage === 'string' ? newMessageImage : null;

        if (oldPhotoFileId && newPhotoFileId && oldPhotoFileId === newPhotoFileId) {
          // Same photo → just edit caption
          return await ctx.editMessageCaption({
            caption: MarkdownV2Escape(text || '', 'escape'),
            parse_mode: 'MarkdownV2',
            reply_markup: content.inline_keyboard ? {
              inline_keyboard: content.inline_keyboard
            } : undefined,
          });
        } else {
          // Different photo → delete old and send new
          try {
            await ctx.deleteMessage();
          } catch (deleteError) {
            // Ignore delete errors
          }
          return await ctx.replyWithPhoto(newMessageImage, {
            caption: MarkdownV2Escape(text || '', 'escape'),
            parse_mode: 'MarkdownV2',
            reply_markup: content.inline_keyboard ? {
              inline_keyboard: content.inline_keyboard
            } : undefined,
          });
        }
      }

      // Case 2: Old has photo, new doesn't → delete old and send text
      if (oldMessageHasPhoto && !newMessageHasPhoto) {
        try {
          await ctx.deleteMessage();
        } catch (deleteError) {
          // Ignore delete errors (message might be too old)
        }
        return await ctx.reply(MarkdownV2Escape(text || '', 'escape'), {
          parse_mode: 'MarkdownV2',
          reply_markup: content.inline_keyboard ? {
            inline_keyboard: content.inline_keyboard
          } : undefined,
        });
      }

      // Case 3: Old is text, new is text → edit text normally
      return await ctx.editMessageText(
        MarkdownV2Escape(text || '', 'escape'),
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: content.inline_keyboard || [],
          }
        },
      )
    } catch (error) {
      if (error instanceof Error && error.message.includes('message is not modified')) {
        logger.debug('Message is not modified, ignoring editMessageText');
      } else {
        throw error;
      }
    }
  }

  async launch(ctx: Context, params: Record<string, string> = {}) {
    return await this.buildFromCommand(params, ctx);
  }

  async startDialogue(dialogueId: string, params: Record<string, string> = {}, uctx: Awaited<ReturnType<TemplateEngine['getUserContext']>>, ctx: Context) {
    const dialogue = this.template.dialogues[dialogueId];
    if (!dialogue) {
      logger.error(`[startDialogue] Dialogue not found: ${dialogueId}`);
      throw new Error(`Dialogue not found: ${dialogueId}`);
    }
    try {
      await dialogue.start(params, uctx, ctx);
      return dialogue;
    } catch (error) {
      logger.error(`[startDialogue] Failed to start dialogue ${dialogueId}:`, error);
      throw error;
    }
  }

  async close(ctx: Context) {
    try {
      return await ctx.deleteMessage();
    } catch (error) {
      if (`${error}`.includes('query is too old')) {
      } else {
        // console.debug('Failed to delete message', error);
        logger.debug('Failed to delete message', error);
      }
    }
  }
}

export interface CacheDriverBase {
  get(key: string): Promise<string | null>;
  set(key: string, value: object, ttlSeconds?: number): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface TemplateEngineParams {
  cacheDriver: CacheDriverBase;
  globalMiddlewares?: PageMiddleware[]; // Global middlewares applied to ALL pages
}

export type DialogueInputType = 'text' | 'buttons' | 'multiple_input';

export interface DialogueStepButton {
  text: string;
  value: string;
}

export interface DialogueFileInput {
  fileId: string;
  fileType: 'photo' | 'video' | 'document' | 'audio' | 'voice' | 'sticker';
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  caption?: string;
}

export interface DialogueInputData {
  text?: string;
  buttonValue?: string;
  customButtonValue?: string; // For custom buttons (Resend OTP, Skip, etc.)
  file?: DialogueFileInput;
  texts?: string[];
  files?: DialogueFileInput[];
}

export type DialogueStep = {
  id: string;
  text: string;
  image?: string; // Optional file path — if set, sends photo with text as caption
  type: DialogueInputType;
  buttons?: DialogueStepButton[]; // Button choices (user picks one to progress)
  customButtons?: DialogueStepButton[]; // Custom action buttons (Resend OTP, Skip, etc. - doesn't progress)
  validate: (input: DialogueInputData) => Promise<[boolean, string?]|boolean>; // return [isValid, errorMessage?]
};

export type DialogueStepsFunction = (params: Record<string, any>, answers: Record<string, DialogueInputData>) => Promise<DialogueStep[]>;

export interface PageDialogueParams {
  id: string;
  steps: DialogueStep[] | DialogueStepsFunction;
  finish: {
    pageId: string;
    params: Record<string, string>;
  };
  cancel: {
    pageId: string;
    params: Record<string, string>;
  };
  onCancel?: (uctx: GetUserContextReturn, ctx: Context) => Promise<void>;
}

export class Dialogue {
  constructor(public template: TemplateEngine, public params: PageDialogueParams) {}

  async start(params: Record<string, any>, uctx: Awaited<ReturnType<TemplateEngine['getUserContext']>>, ctx: Context) {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) {
      logger.error('[Dialogue.start] Missing chatId or userId');
      return ctx.reply('Unable to start dialogue in this context.');
    }

    logger.debug(`[Dialogue.start] Starting dialogue ${this.params.id}`, { params });

    // set current dialogue state to user context
    await uctx.set('dialogue', {
      id: this.params.id,
      stepIndex: 0,
      params,
      answers: {},
      complete: false,
      msg_ids: [],
    });

    await this.processStep(uctx, ctx);
  }

  async processStep(uctx: Awaited<ReturnType<TemplateEngine['getUserContext']>>, ctx: Context) {
    const dialogueState = await uctx.get('dialogue') as DialogueState | null;
    if (!dialogueState) return;

    // Get steps (static or dynamic)
    let steps: DialogueStep[];
    if (typeof this.params.steps === 'function') {
      steps = await this.params.steps(dialogueState.params, dialogueState.answers);
    } else {
      steps = this.params.steps;
    }

    const step = steps[dialogueState.stepIndex];
    if (!step) {
      // dialogue complete
      await uctx.delete('dialogue');
      return ctx.reply('Dialogue complete. Thank you!');
    }

    // Build inline keyboard based on step type
    let inlineKeyboard: InlineKeyboardButton[][] = [];

    if (step.type === 'buttons' && step.buttons) {
      // Add buttons as first row
      const buttonRow = step.buttons.map((btn: DialogueStepButton) => ([{
        text: btn.text,
        callback_data: this.template.createDialogueButtonData(this.params.id, step.id, btn.value),
      }]));
      inlineKeyboard.push(...buttonRow);
    }

    // Add custom buttons (Resend OTP, Skip, etc.) - works for all step types
    if (step.customButtons && step.customButtons.length > 0) {
      const customButtonRow = step.customButtons.map((btn: DialogueStepButton) => ({
        text: btn.text,
        callback_data: this.template.createDialogueButtonData(this.params.id, step.id, `c:${btn.value}`),  // Shortened prefix
      }));
      inlineKeyboard.push(customButtonRow);
    }

    if (step.type === 'multiple_input') {
      // Initialize multipleInputs array if not exists
      if (!dialogueState.multipleInputs) {
        dialogueState.multipleInputs = [];
      }

      // For initial message, only show "Batal" button
      // "Selesai" button will appear after user sends first message
      inlineKeyboard.push([
        {
          text: '❌ Batal',
          callback_data: this.template.createQueryInlineData(this.params.cancel.pageId, { ...this.params.cancel.params, _dc: true }),
        }
      ]);
    } else {
      // Add control buttons (Cancel, Exit) for other step types
      if (this.params.cancel?.pageId) {
        inlineKeyboard.push([
          {
            text: 'Cancel',
            callback_data: this.template.createQueryInlineData(this.params.cancel.pageId, { ...this.params.cancel.params, _dc: true }),
          },
          // {
          //   text: 'Exit',
          //   callback_data: `p|exit|_dc=true`,
          // }
        ]);
      } else {
        inlineKeyboard.push([
          {
            text: 'Exit',
            callback_data: `p|exit|_dc=true`,
          }
        ]);
      }
    }

    const _text = MarkdownV2Escape(step.text, 'escape');
    let msg;
    try {
      if (step.image) {
        logger.debug(`[Dialogue.processStep] Sending photo for step ${step.id}`, { image: step.image });
        msg = await ctx.replyWithPhoto(new InputFile(step.image), {
          caption: _text,
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: inlineKeyboard,
          },
        });
      } else {
        msg = await ctx.reply(_text, {
          reply_markup: {
            inline_keyboard: inlineKeyboard,
          },
          parse_mode: 'MarkdownV2',
        });
      }
      dialogueState.msg_ids.push(msg.message_id);
      await uctx.set('dialogue', dialogueState);
    } catch (error) {
      logger.error(`[Dialogue.processStep] Failed to send message for dialogue ${this.params.id}:`, error);
      throw error;
    }
  }
}

export type GetUserContextReturn = {
  contexts: Record<string, any>;
  get: <T = null>(key: string) => Promise<T|null>;
  set: (key: string, value: any) => Promise<void>;
  set_batch: (data: Record<string, any>) => Promise<void>;
  delete: (...keys: string[]) => Promise<void>;
}

export type DialogueState = {
  id: string;
  stepIndex: number;
  params: Record<string, any>;
  answers: Record<string, DialogueInputData>;
  complete: boolean;
  msg_ids: number[];
  multipleInputs?: string[]; // temporary storage for collecting multiple text inputs
  multipleFiles?: DialogueFileInput[]; // temporary storage for collecting multiple file inputs
}

/**
 * Cache entry with TTL expiration
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number; // Unix timestamp (ms)
}

export class TemplateEngine {
  pages: Record<string, Page> = {};
  dialogues: Record<string, Dialogue> = {};

  // MEMORY LEAK FIX: Added TTL expiration to prevent indefinite cache growth
  private userContextCache = new Map<string, CacheEntry<GetUserContextReturn>>();
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute (60 seconds)
  private cleanupInterval?: NodeJS.Timeout;

  // Global middlewares applied to ALL pages
  public globalMiddlewares: PageMiddleware[] = [];

  constructor(public bot: Bot<Context, Api<RawApi>>, public params: TemplateEngineParams) {
    // Store global middlewares
    this.globalMiddlewares = params.globalMiddlewares || [];

    // Start periodic cleanup of expired cache entries
    this.startCacheCleanup();
  }

  /**
   * Start periodic cleanup of expired cache entries
   * Runs every 1 minute to remove stale entries
   */
  private startCacheCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [key, entry] of this.userContextCache.entries()) {
        if (now > entry.expiresAt) {
          this.userContextCache.delete(key);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.debug(`[TemplateEngine] Cache cleanup: removed ${cleanedCount} expired entries`);
      }
    }, this.CACHE_TTL_MS); // Run cleanup every 1 minute
  }

  /**
   * Clean up resources when shutting down
   * Call this when gracefully stopping the bot
   */
  public destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.userContextCache.clear();
    logger.info('[TemplateEngine] Cache cleanup interval stopped and cache cleared');
  }

  createQueryInlineData(pageId: string, params: object) {
    // convert params to a=x&b=y&c=z
    const query = new URLSearchParams(params as Record<string, string>).toString();
    const data = `p|${pageId}|${query}`;

    logger.debug(`[createQueryInlineData] pageId: ${pageId}, params:`, params, `-> data: ${data}`);

    // validate length, telegram callback data max 64 bytes using utf-8
    if (Buffer.byteLength(data, 'utf-8') > 64) {
      logger.error('[CAPTURE_ERROR] Callback data too long:', { data, length: Buffer.byteLength(data, 'utf-8') });
      // ERR_CODE: tpl_b_dtl (template button data too long)
      return `p|syserr|code=tpl_b_dtl`;
    }

    return data;
  }

  createDialogueButtonData(dialogueId: string, stepId: string, buttonValue: string) {
    // Use short codes to minimize callback data length
    const params = {
      _di: dialogueId,    // dialogue id
      _si: stepId,        // step id  
      _bv: buttonValue     // button value
    };
    const query = new URLSearchParams(params).toString();
    return `p|_db|${query}`;
  }

  addDialogue(params: PageDialogueParams) {
    const dialogue = new Dialogue(this, params);
    this.dialogues[dialogue.params.id] = dialogue;
    return dialogue;
  }

  addPage(params: PageRenderParams) {
    const page = new Page(this, params);
    this.pages[page.params.id] = page;
    return page;
  }

  async runDialogueStep(ctx: Context) {
    const uctx = await this.getUserContext(ctx);
    const dialogueState = await uctx.get('dialogue') as DialogueState | null;
    if (!dialogueState) return false; // no active dialogue
    if (dialogueState.complete === true) return false; // dialogue already complete

    const dialogue = this.dialogues[dialogueState.id];
    if (!dialogue) throw new Error('Dialogue not found');
    // console.log('runDialogueStep', dialogue);

    // Get steps (static or dynamic)
    let steps: DialogueStep[];
    if (typeof dialogue.params.steps === 'function') {
      steps = await dialogue.params.steps(dialogueState.params, dialogueState.answers);
    } else {
      steps = dialogue.params.steps;
    }

    // validate first step
    const step = steps[dialogueState.stepIndex];
    if (!step) throw new Error('Dialogue step not found');

    // remove previous message
    try {
      await ctx.deleteMessages(dialogueState.msg_ids);
      dialogueState.msg_ids = [];
    } catch (error) {
      if (`${error}`.includes('query is too old')) {
      } else {
        // console.debug('Failed to delete message', error);
        logger.error('Failed to delete message', error);
      }
    }

    // Helper: Extract file info from message
    const extractFileFromMessage = (msg: any): DialogueFileInput | null => {
      if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1]; // Get largest photo
        return {
          fileId: photo.file_id,
          fileType: 'photo',
          fileSize: photo.file_size,
          caption: msg.caption,
        };
      } else if (msg.video) {
        return {
          fileId: msg.video.file_id,
          fileType: 'video',
          fileName: msg.video.file_name,
          fileSize: msg.video.file_size,
          mimeType: msg.video.mime_type,
          caption: msg.caption,
        };
      } else if (msg.document) {
        return {
          fileId: msg.document.file_id,
          fileType: 'document',
          fileName: msg.document.file_name,
          fileSize: msg.document.file_size,
          mimeType: msg.document.mime_type,
          caption: msg.caption,
        };
      } else if (msg.audio) {
        return {
          fileId: msg.audio.file_id,
          fileType: 'audio',
          fileName: msg.audio.file_name,
          fileSize: msg.audio.file_size,
          mimeType: msg.audio.mime_type,
          caption: msg.caption,
        };
      } else if (msg.voice) {
        return {
          fileId: msg.voice.file_id,
          fileType: 'voice',
          fileSize: msg.voice.file_size,
          mimeType: msg.voice.mime_type,
          caption: msg.caption,
        };
      } else if (msg.sticker) {
        return {
          fileId: msg.sticker.file_id,
          fileType: 'sticker',
          fileSize: msg.sticker.file_size,
        };
      }
      return null;
    };

    // handle different input types
    let input: DialogueInputData = {};

    // Handle multiple_input type
    if (step.type === 'multiple_input') {
      const hasTextInput = !!ctx.message?.text;
      const fileInput = ctx.message ? extractFileFromMessage(ctx.message) : null;

      if (hasTextInput || fileInput) {
        // Initialize arrays if not exist
        if (!dialogueState.multipleInputs) {
          dialogueState.multipleInputs = [];
        }
        if (!dialogueState.multipleFiles) {
          dialogueState.multipleFiles = [];
        }

        // Collect text input
        if (hasTextInput && ctx.message?.text) {
          dialogueState.multipleInputs.push(ctx.message.text);
        }

        // Collect file input
        if (fileInput) {
          dialogueState.multipleFiles.push(fileInput);
        }

        await uctx.set('dialogue', dialogueState);

        // Reply with acknowledgment and buttons
        const textCount = dialogueState.multipleInputs.length;
        const fileCount = dialogueState.multipleFiles.length;
        const totalCount = textCount + fileCount;

        const msg = await ctx.reply(MarkdownV2Escape([
          `Saya telah menerima ${totalCount} input anda (${textCount} teks, ${fileCount} file).`,
          '- Tekan ✅ Selesai jika sudah selesai mengirim',
          '- Tekan ❌ Batal jika ingin membatalkan',
        ].join('\n'), 'escape'), {
          parse_mode: 'MarkdownV2',
          reply_parameters: ctx.message?.message_id ? {
            message_id: ctx.message.message_id,
          } : undefined,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✅ Selesai',
                  callback_data: this.createDialogueButtonData(dialogueState.id, step.id, '__finish__'),
                },
                {
                  text: '❌ Batal',
                  callback_data: this.createQueryInlineData(dialogue.params.cancel.pageId, { ...dialogue.params.cancel.params, _dc: true }),
                }
              ]
            ]
          }
        });
        dialogueState.msg_ids.push(msg.message_id);
        await uctx.set('dialogue', dialogueState);
        return true; // still in dialogue, waiting for more inputs or finish
      } else if (ctx.callbackQuery?.data) {
        // Check if user clicked "Selesai" button
        const data = ctx.callbackQuery.data;
        const parts = data.split('|');
        if (parts[0] === 'p' && parts[1] === '_db') {
          const queryString = parts.slice(2).join('|');
          const params = Object.fromEntries(new URLSearchParams(queryString));
          if (params._di === dialogueState.id && params._si === step.id && params._bv === '__finish__') {
            // User finished collecting inputs
            const hasTexts = dialogueState.multipleInputs && dialogueState.multipleInputs.length > 0;
            const hasFiles = dialogueState.multipleFiles && dialogueState.multipleFiles.length > 0;

            if (!hasTexts && !hasFiles) {
              await ctx.answerCallbackQuery({ text: 'Anda belum mengirim input apapun', show_alert: true });
              return true;
            }

            if (hasTexts) input.texts = dialogueState.multipleInputs;
            if (hasFiles) input.files = dialogueState.multipleFiles;

            // Clear temporary storage for next step
            dialogueState.multipleInputs = [];
            dialogueState.multipleFiles = [];
          } else {
            return true; // not the finish button
          }
        } else {
          return true; // not dialogue button
        }
      } else {
        return true; // no valid input
      }
    } else {
      // Handle normal text and button inputs
      if (ctx.message?.text) {
        // text input
        input.text = ctx.message.text;
      } else if (ctx.message) {
        // file input
        const fileInput = extractFileFromMessage(ctx.message);
        if (fileInput) {
          input.file = fileInput;
        }
      } else if (ctx.callbackQuery?.data) {
        // button input - parse callback data
        const data = ctx.callbackQuery.data;
        const parts = data.split('|');
        if (parts[0] === 'p' && parts[1] === '_db') {
          const queryString = parts.slice(2).join('|');
          const params = Object.fromEntries(new URLSearchParams(queryString));
          if (params._di === dialogueState.id && params._si === step.id) {
            const buttonValue = params._bv;
            // Check if it's a custom button (prefixed with c:)
            if (buttonValue && buttonValue.startsWith('c:')) {
              input.customButtonValue = buttonValue.replace('c:', '');
            } else {
              input.buttonValue = buttonValue;
            }
          }
        }
      }

      // if no valid input, return
      if (!input.text && !input.buttonValue && !input.file && !input.customButtonValue) {
        return true; // still in dialogue
      }
    }

    // Handle custom button clicks (Resend OTP, Skip, etc.)
    if (input.customButtonValue) {
      // Custom buttons trigger actions but DON'T progress to next step
      // Validation function should handle the custom action (e.g., resend OTP)
      const customResult = await step.validate(input);

      // Check if validation returned error message
      if (Array.isArray(customResult) && !customResult[0]) {
        // Show error message from custom button action
        const errorMessage = customResult[1] || 'Action failed, please try again.';

        // Create cancel button (consistent with dialogue step buttons)
        const cancelButton = {
          text: 'Cancel',
          callback_data: dialogue.template.createQueryInlineData(
            dialogue.params.cancel.pageId,
            { ...dialogue.params.cancel.params, _dc: true }
          ),
        };

        // Send as new message (not reply) to avoid "message to be replied not found" error
        await ctx.api.sendMessage(ctx.chat!.id, MarkdownV2Escape(errorMessage, 'escape'), {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[cancelButton]]
          }
        });
        return true; // still in dialogue
      }

      // Success - re-render same step (don't progress)
      await dialogue.processStep(uctx, ctx);
      return true; // still in dialogue
    }

    const isValid = await step.validate(input);
    if (Array.isArray(isValid)) {
      if (!isValid[0]) {
        // invalid with error message — send error then re-render current step
        const errorMessage = (isValid[1] || 'Input tidak valid, coba lagi.') + '\n\n*Tolong input kembali:*';

        const errorMsg = await ctx.api.sendMessage(ctx.chat!.id, MarkdownV2Escape(errorMessage, 'escape'), {
          parse_mode: 'MarkdownV2',
        });
        dialogueState.msg_ids.push(errorMsg.message_id);
        await uctx.set('dialogue', dialogueState);

        // Re-render the current step so user sees the question again
        await dialogue.processStep(uctx, ctx);
        return true; // still in dialogue
      }
    } else {
      if (!isValid) {
        // invalid - generic error — send error then re-render current step
        const errorMessage = 'Input tidak valid, coba lagi.\n\nTolong input kembali:';

        const errorMsg = await ctx.api.sendMessage(ctx.chat!.id, MarkdownV2Escape(errorMessage, 'escape'), {
          parse_mode: 'MarkdownV2',
        });
        dialogueState.msg_ids.push(errorMsg.message_id);
        await uctx.set('dialogue', dialogueState);

        // Re-render the current step so user sees the question again
        await dialogue.processStep(uctx, ctx);
        return true; // still in dialogue
      }
    }

    // save answer
    dialogueState.answers[step.id] = input;
    dialogueState.stepIndex += 1;

    // check if dialogue is complete
    if (dialogueState.stepIndex >= steps.length) {
      // console.log('dialogue complete', dialogueState.answers);
      logger.debug('Dialogue complete', { dialogueId: dialogueState.id, answers: dialogueState.answers });
      // dialogue complete
      // await uctx.delete('dialogue');
      dialogueState.complete = true;
      //
      await uctx.set('dialogue', dialogueState);
      // navigate to finish page
      return await this.launch(ctx, dialogue.params.finish.pageId, {
        ...dialogue.params.finish.params,
      });
    }

    await uctx.set('dialogue', dialogueState);

    // process next step
    await dialogue.processStep(uctx, ctx);
  }

  async runFromCommand(ctx: Context, pageId: string|Page, params: Record<string, string> = {}) {
    // const page = (typeof pageId === 'string') ? this.pages[pageId] : this.pages[pageId.params.id];
    pageId = (typeof pageId === 'string') ? pageId : pageId.params.id;
    const page = this.pages[pageId];
    if (!page) return await ctx.reply('Page not found');
    // logger.debug(`running page from command: ${pageId}`, { params });
    return await page.buildFromCommand(params, ctx);
  }

  async runFromCallbackQuery(ctx: Context) {
    if (!ctx.callbackQuery?.data) return;

    let data = ctx.callbackQuery.data;
    logger.debug(`[runFromCallbackQuery] RAW callback data: ${data}`);
    
    // if data is "home" or "index", treat it as page navigation to "home" page
    if (data === 'home' || data === 'index') {
      data = `p|home`; // rewrite to standard page navigation format
      logger.debug(`[runFromCallbackQuery] Rewriting callback data to: ${data}`);
    }

    const parts = data.split('|');
    logger.debug(`[runFromCallbackQuery] parts[0]: ${parts[0]}, parts[1]: ${parts[1]}`);

    if (parts[0] !== 'p') {
      logger.debug(`[runFromCallbackQuery] NOT a page navigation (parts[0]='${parts[0]}'), deleting message`);
      try {
        await ctx.deleteMessage()
      } catch (error) {}
      return; // not a page navigation
    }

    const pageId = parts[1];
    const queryString = parts.slice(2).join('|'); // in case '|' is in params
    const params = Object.fromEntries(new URLSearchParams(queryString));

    logger.debug(`[runFromCallbackQuery] pageId: ${pageId}, params:`, params);

    // handle dialogue button clicks
    if (pageId === '_db') {
      // ack the callback
      try {
        await ctx.answerCallbackQuery();
      } catch (error) {}

      // process the dialogue step with button input
      try {
        return await this.runDialogueStep(ctx);
      } catch (error) {
        logger.error('[runFromCallbackQuery] Failed to run dialogue step:', error);
        try {
          await ctx.answerCallbackQuery({ text: 'Terjadi kesalahan saat memproses input', show_alert: true });
        } catch (_) {}
        return;
      }
    }

    // if params have _dc=true,  remove uctx dialogue state
    if (params['_dc'] === 'true') {
      try {
        const uctx = await this.getUserContext(ctx);
        const dialogueState = await uctx.get('dialogue') as DialogueState | null;
        if (dialogueState) {
          logger.debug('Deleting dialogue state due to _dc=true', { dialogueId: dialogueState.id });

          // Call onCancel handler if defined (for dialogue-specific cleanup)
          const dialogue = this.dialogues[dialogueState.id];
          if (dialogue?.params.onCancel) {
            try {
              await dialogue.params.onCancel(uctx, ctx);
            } catch (error) {
              logger.error('[runFromCallbackQuery] onCancel handler failed:', error);
            }
          }

          // remove dialogue state
          await uctx.delete('dialogue');
        }
        delete params['_dc'];
      } catch (error) {
        logger.error('[runFromCallbackQuery] Failed to handle dialogue cancel:', error);
        // Continue execution even if cancel fails
      }
    }

    // specific page
    if (pageId === 'exit') {
      try {
        return await ctx.deleteMessage();
      } catch (error) {
        if (`${error}`.includes('query is too old')) {
        } else {
          // console.debug('Failed to delete message', error);
          logger.debug('Failed to delete message', error);
        }
      }
    }

    const page = this.pages[pageId as string];
    if (!page) {
      try {
        return await ctx.answerCallbackQuery({ text: 'Page not found', show_alert: true });
      } catch (error) {
        logger.error('[runFromCallbackQuery] Failed to show page not found alert:', error);
      }
      return;
    }

    // ack
    try {
      await ctx.answerCallbackQuery(); // acknowledge the callback
    } catch (error) {
      // Ignore ack errors
    }

    // render
    try {
      return await page.buildFromCallbackQuery(ctx, params);
    } catch (error) {
      logger.error(`[runFromCallbackQuery] Failed to render page ${pageId}:`, error);
      try {
        await ctx.answerCallbackQuery({ text: 'Terjadi kesalahan saat memuat halaman', show_alert: true });
      } catch (_) {}
    }
  }

  async launch(ctx: Context, pageId: string, params: Record<string, string> = {}) {
    const page = this.pages[pageId];
    // console.log('Launching page', pageId, params);
    if (!page) return await ctx.reply('Page not found');
    return await page.launch(ctx, params);
  }

  async getUserContext(ctx: Context): Promise<GetUserContextReturn> {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const cacheKey = `${chatId}:${userId}`;

    // Check Map cache first using chatId:userId as key
    // MEMORY LEAK FIX: Check expiration before returning cached value
    const cached = this.userContextCache.get(cacheKey);
    if (cached) {
      const now = Date.now();
      if (now < cached.expiresAt) {
        // Cache is still valid, return cached value
        // console.log('getUserContext from cache (valid)');
        return cached.value;
      } else {
        // Cache expired, remove it
        this.userContextCache.delete(cacheKey);
        // console.log('getUserContext cache expired, removed');
      }
    }

    // const contexts_str =
    const contexts: Record<string, any> = await this.params.cacheDriver.get(`userctx:${chatId}:${userId}`) as any || {};
    // if (contexts_str) {
    //   try {
    //     contexts = JSON.parse(contexts_str);
    //   } catch (e) {
    //     console.error('Failed to parse user context', e);
    //   }
    // }
    // console.log('getUserContext', { chatId, userId, contexts });
    const res = {
      contexts,
      get: async (key: string) => contexts[key],
      set: async (key: string, value: any) => {
        contexts[key] = value;
        await this.params.cacheDriver.set(`userctx:${chatId}:${userId}`, contexts);
      },
      set_batch: async (data: Record<string, any>) => {
        for (const k in data) {
          contexts[k] = data[k];
        }
        await this.params.cacheDriver.set(`userctx:${chatId}:${userId}`, contexts);
      },
      // delete: async (key: string) => {
      //   delete contexts[key];
      //   if (Object.keys(contexts).length === 0) {
      //     await this.template.params.cacheDriver.delete?.(`userctx:${chatId}:${userId}`);
      //   } else {
      //     await this.template.params.cacheDriver.set(`userctx:${chatId}:${userId}`, contexts);
      //   }
      // },
      delete: async (...keys: string[]) => {
        for (const k of keys) {
          delete contexts[k];
        }
        if (Object.keys(contexts).length === 0) {
          await this.params.cacheDriver.delete?.(`userctx:${chatId}:${userId}`);
        } else {
          await this.params.cacheDriver.set(`userctx:${chatId}:${userId}`, contexts);
        }
      },
    };

    // Cache to Map using chatId:userId as key
    // MEMORY LEAK FIX: Store with expiration timestamp (TTL: 1 minute)
    this.userContextCache.set(cacheKey, {
      value: res,
      expiresAt: Date.now() + this.CACHE_TTL_MS, // Expires in 1 minute
    });

    return res;
  }
}


// utils
export const createPagination = async (
  // Parameters<PageRenderFunction> but object destructuring
  pagecontext: Parameters<PageRenderFunction>,
  // pagecontext: []
  options: {
    defaultPage: number,
    total: number,
    itemPerPage: number,
  },
  // defaultPage: number,
  // total: number,
  // itemPerPage: number,
  builder: (page: number, totalPages: number, navigationButtons: InlineKeyboardButton[]) => PageRenderFunction,
) => {
  const { defaultPage, total, itemPerPage } = options;
  let totalPages = Math.ceil(total / itemPerPage);
  if (totalPages === 0) totalPages = 1;
  const currentPage = pagecontext[1]._pc ? parseInt(pagecontext[1]._pc) : defaultPage;

  // build pagination buttons
  const paginations: InlineKeyboardButton[] = [];

  // shorcut to jump to first page
  if (totalPages > 2 && currentPage !== 1) {
    paginations.push(
      pagecontext[0].createButtonNav(
        // emoji skip to first page
        `⏮️`,
        pagecontext[0].params.id,
        { ...pagecontext[1], _pc: 1 }
      )
    );
  }
  
  if (currentPage > 1) {
    paginations.push(
      pagecontext[0].createButtonNav(
        '⬅️',
        pagecontext[0].params.id,
        { ...pagecontext[1], _pc: currentPage - 1 }
      )
    );
  }

  // current page indicator
  paginations.push(
    pagecontext[0].createButtonNav(
      `${currentPage} / ${totalPages}`,
      pagecontext[0].params.id,
      { ...pagecontext[1], _pc: currentPage }
    )
  );

  // next
  if (currentPage < totalPages) {
    paginations.push(
      pagecontext[0].createButtonNav(
        '➡️',
        pagecontext[0].params.id,
        { ...pagecontext[1], _pc: currentPage + 1 }
      )
    );
  }

  // jump to last
  if (totalPages > 2 && currentPage !== totalPages) {
    paginations.push(
      pagecontext[0].createButtonNav(
        // emoji skip to last page
        `⏭️`,
        pagecontext[0].params.id,
        { ...pagecontext[1], _pc: totalPages }
      )
    );
  }

  // return
  return builder(currentPage, totalPages, paginations)(...pagecontext);
}
