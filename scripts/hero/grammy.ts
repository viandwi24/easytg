/** `grammy` as the hero bot sees it: its Bot connects to the page's simulator. */
import * as grammy from 'grammy';
import type { TelegramSimulator } from '@easytg/simulator';

export * from 'grammy';

export class Bot extends grammy.Bot {
  constructor(_token: string) {
    const sim = (globalThis as unknown as { heroSim: TelegramSimulator }).heroSim;
    super(sim.token, { botInfo: sim.botInfo });
    sim.connect(this as unknown as grammy.Bot<any>);
  }
}
