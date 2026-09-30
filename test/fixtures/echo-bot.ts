// A bot file as users write it: token from the environment, bot.start() at the end.
import { Bot, InputFile } from 'grammy';
import { EasyTG, page } from '../../src';

const home = page('home').render(({ nav }) => ({ text: 'Home', keyboard: [[nav.button('Photo', photo)]] }));
const photo = page('photo').render(() => ({ photo: new InputFile(new Uint8Array([137, 80, 78, 71]), 'dot.png'), text: 'A photo' }));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG({ logger: false }).command('start', home).register(photo);
bot.use(app);
bot.on('message:text', (ctx) => ctx.reply(`echo: ${ctx.message.text}`));
await bot.start();
