export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const noop = () => {};

/**
 * Default logger: warnings and errors go to the console, debug/info only when
 * `EASYTG_DEBUG=1` is set.
 */
export function createConsoleLogger(debug = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EASYTG_DEBUG === '1'): Logger {
  return {
    debug: debug ? (m, ...a) => console.debug(`[easytg] ${m}`, ...a) : noop,
    info: debug ? (m, ...a) => console.info(`[easytg] ${m}`, ...a) : noop,
    warn: (m, ...a) => console.warn(`[easytg] ${m}`, ...a),
    error: (m, ...a) => console.error(`[easytg] ${m}`, ...a),
  };
}

export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
