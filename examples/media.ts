/**
 * Every kind of media a page can show, in one menu. Switching between them
 * edits the same message in place.
 *
 *   BOT_TOKEN=123:abc bun run examples/media.ts
 *
 * Media can be a Telegram file_id, an HTTP(S) URL, or an InputFile (local file
 * or buffer). The URLs below are public samples; replace them with your own.
 */
import { Bot, InputFile } from 'grammy';
import { EasyTG, page } from '../src';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/media.ts');
  process.exit(1);
}

const samples = {
  photo: 'https://picsum.photos/seed/easytg/800/500',
  video: 'https://www.w3schools.com/html/mov_bbb.mp4',
  animation: 'https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif',
  audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
};

const home = page('home').render(({ nav }) => ({
  text: '**Media demo**\nPick a type:',
  keyboard: [
    [nav.button('🖼 Photo', photo), nav.button('🎬 Video', video), nav.button('🌀 GIF', animation)],
    [nav.button('📄 Document', document), nav.button('🎵 Audio', audio)],
    [nav.button('🗂 Album', album)],
    [nav.close()],
  ],
}));

const photo = page('photo').render(({ nav }) => ({
  photo: samples.photo,
  text: 'A **photo**. The text becomes its caption.',
  keyboard: [[nav.back()]],
}));

const video = page('video').render(({ nav }) => ({
  video: samples.video,
  text: 'A **video**.',
  keyboard: [[nav.back()]],
}));

const animation = page('animation').render(({ nav }) => ({
  animation: samples.animation,
  text: 'An **animation** (GIF).',
  keyboard: [[nav.back()]],
}));

// A generated file: InputFile accepts buffers, streams and local paths.
const document = page('document').render(({ ctx, nav }) => ({
  document: new InputFile(Buffer.from(`Report for ${ctx.from?.first_name}\nGenerated ${new Date().toISOString()}\n`), 'report.txt'),
  text: 'A **document** generated on the fly.',
  keyboard: [[nav.back()]],
}));

const audio = page('audio').render(({ nav }) => ({
  audio: samples.audio,
  text: 'An **audio** file.',
  keyboard: [[nav.back()]],
}));

// Albums (2–10 items) can't carry buttons, so text + keyboard follow in their own
// message. Without a keyboard the text would be the album caption instead.
const album = page('album').render(({ nav }) => ({
  album: [
    { type: 'photo', media: 'https://picsum.photos/seed/a/600/400' },
    { type: 'photo', media: 'https://picsum.photos/seed/b/600/400' },
    { type: 'video', media: samples.video },
  ],
  text: 'An **album**: photos and a video in one group.',
  keyboard: [[nav.back()]],
}));

const bot = new Bot(token);
const app = new EasyTG().register(home, photo, video, animation, document, audio, album);

bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
