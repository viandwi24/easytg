import type { InlineKeyboardButton } from 'grammy/types';
import type { Nav } from './nav';
import type { Params } from './types';

export interface PaginateOptions {
  total: number;
  perPage: number;
  /** Param holding the page number. Default `page`. */
  param?: string;
}

export interface Pagination {
  /** Current page, 1-based, clamped to `[1, totalPages]`. */
  page: number;
  totalPages: number;
  /** Index of the first item on this page (for `slice` / SQL `OFFSET`). */
  offset: number;
  limit: number;
  /** ⏮️ ⬅️ n/N ➡️ ⏭️ — put it in a keyboard row. */
  buttons: InlineKeyboardButton[];
}

/**
 * Page numbers for the current page render:
 *
 *   const { offset, limit, buttons } = paginate(args, { total, perPage: 10 });
 *   return { text: items.slice(offset, offset + limit), keyboard: [buttons] };
 */
export function paginate(args: { params: Params; nav: Nav<any> }, options: PaginateOptions): Pagination {
  const param = options.param ?? 'page';
  const perPage = Math.max(1, Math.floor(options.perPage));
  const totalPages = Math.max(1, Math.ceil(options.total / perPage));
  // Params are untrusted: clamp anything odd.
  const parsed = Number.parseInt(args.params[param] ?? '1', 10);
  const page = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 1, 1), totalPages);

  const nav = (text: string, target: number) => args.nav.self(text, { [param]: target });
  const buttons: InlineKeyboardButton[] = [];
  if (totalPages > 2 && page > 1) buttons.push(nav('⏮️', 1));
  if (page > 1) buttons.push(nav('⬅️', page - 1));
  buttons.push(nav(`${page} / ${totalPages}`, page));
  if (page < totalPages) buttons.push(nav('➡️', page + 1));
  if (totalPages > 2 && page < totalPages) buttons.push(nav('⏭️', totalPages));

  return { page, totalPages, offset: (page - 1) * perPage, limit: perPage, buttons };
}
