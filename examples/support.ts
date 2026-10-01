/**
 * A support desk: customers describe their problem, an agent takes the
 * ticket, and they talk through the bot. Neither sees the other's account.
 *
 *   BOT_TOKEN=123:abc AGENT_IDS=<your user id>[,<another>] bun run examples/support.ts
 *
 * Try it with two accounts: one as the agent (its id in AGENT_IDS), one as a
 * customer. In the playground you are the agent; switch to Alice at the top
 * of the chat to be the customer.
 *
 * Shows: `app.relay` (start, end, peer, `data`), the `relay.filter` option
 * (customers can't send links), replies and edits carried to the other side,
 * the `relayEnd` event for a customer who blocked the bot, `app.sendTo` to
 * notify agents, a `choice` dialogue for the rating, and `app.command`.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page } from '../src';

const AGENTS = (process.env.AGENT_IDS ?? process.env.ADMIN_ID ?? '').split(',').map(Number).filter(Boolean);
const isAgent = (id: number | undefined) => id !== undefined && AGENTS.includes(id);

interface Ticket {
  id: number;
  customer: number;
  name: string;
  problem: string;
  agent?: number;
  status: 'waiting' | 'open' | 'closed';
  rating?: string;
}
/** Stands in for your database. */
const tickets: Ticket[] = [];

// ---- customers ------------------------------------------------------------------

const home = page('home').render(({ ctx, nav }) =>
  isAgent(ctx.from?.id)
    ? { text: ['🎧 **Agent desk**', `${tickets.filter((t) => t.status === 'waiting').length} ticket(s) waiting.`], keyboard: [[nav.button('📥 Waiting tickets', queue)]] }
    : { text: ['👋 **Help center**', 'Questions about your order? Talk to a person.'], keyboard: [[nav.button('💬 Talk to support', newTicket)]] },
);

const newTicket = dialogue('new-ticket')
  .steps([{ id: 'problem', type: 'text', text: 'What can we help with? Describe it in a message.', validate: (t) => t.length >= 5 || 'A few more words, please.' }])
  .onFinish(async ({ ctx, answers }) => {
    const ticket: Ticket = { id: tickets.length + 1, customer: ctx.from!.id, name: ctx.from!.first_name, problem: answers.problem, status: 'waiting' };
    tickets.push(ticket);
    for (const agent of AGENTS) await app.sendTo(bot, agent, newTicketNotice, { id: String(ticket.id) });
    return { text: md`🎫 Ticket #${ticket.id} is in the queue. An agent will be with you shortly.` };
  })
  .onCancel(({ nav }) => nav.redirect(home));

// ---- agents -----------------------------------------------------------------------

const newTicketNotice = page<{ id: string }>('new-ticket-notice').render(({ params, nav }) => {
  const ticket = tickets.find((t) => t.id === Number(params.id));
  if (!ticket) return;
  return { text: [md`🆕 **Ticket #${ticket.id}** from ${ticket.name}`, md`“${ticket.problem}”`], keyboard: [[nav.button(`✋ Take #${ticket.id}`, take, { id: params.id })]] };
});

const queue = page('queue').render(({ nav }) => {
  const waiting = tickets.filter((t) => t.status === 'waiting');
  return {
    text: ['📥 **Waiting tickets**', ...(waiting.length ? waiting.map((t) => md`#${t.id} ${t.name}: “${t.problem}”`) : ['None. 🎉'])],
    keyboard: [...waiting.map((t) => [nav.button(`✋ Take #${t.id}`, take, { id: String(t.id) })]), [nav.self('🔄 Refresh')]],
  };
});

const take = page<{ id: string }>('take')
  // Agents only: anyone else pressing it (a forwarded notice) just gets the home page.
  .use(({ ctx, nav }, next) => (isAgent(ctx.from?.id) ? next() : nav.redirect(home)))
  .render(async ({ ctx, params, app }) => {
    const ticket = tickets.find((t) => t.id === Number(params.id));
    if (!ticket || ticket.status !== 'waiting') return { text: 'Someone else took this ticket.' };
    const agent = ctx.from!.id;
    if (await app.relay.peer(ctx, agent)) return { text: 'Close your current ticket first (/close).' };
    ticket.status = 'open';
    ticket.agent = agent;
    await app.relay.start(ctx, agent, ticket.customer, { data: { ticket: ticket.id } });
    await app.sendTo(bot, ticket.customer, connected);
    return { text: [md`🎧 You're on **ticket #${ticket.id}** with ${ticket.name}.`, md`“${ticket.problem}”`, 'Messages you send now go to them. /close when done.'] };
  });

const connected = page('connected').render(() => ({ text: '🎧 An agent joined. Write here: your messages go to them. /close to end the chat.' }));

// ---- closing and rating ---------------------------------------------------------------

const close = page('close').render(async ({ ctx, app, nav }) => {
  const link = await app.relay.end(ctx, ctx.from!.id);
  if (!link) return { text: "You're not in a support chat." };
  const ticket = tickets.find((t) => t.id === (link.data as { ticket: number }).ticket)!;
  ticket.status = 'closed';
  const customer = ticket.customer;
  const agent = ticket.agent!;
  await app.sendTo(bot, ctx.from!.id === agent ? customer : agent, closedByOther, { id: String(ticket.id) });
  if (ctx.from!.id === customer) return nav.startDialogue(rate, { id: String(ticket.id) });
  return { text: md`✅ Ticket #${ticket.id} closed.` };
});

const closedByOther = page<{ id: string }>('closed-by-other').render(({ ctx, params, nav }) => {
  const ticket = tickets.find((t) => t.id === Number(params.id));
  if (!ticket) return;
  if (ctx.from?.id === ticket.customer) return nav.startDialogue(rate, { id: params.id });
  return { text: md`The customer closed ticket #${ticket.id}.` };
});

const rate = dialogue<{ stars: string }, { id: string }>('rate')
  .steps([
    {
      id: 'stars',
      type: 'choice',
      text: '✅ Chat closed. How did we do?',
      columns: 5,
      options: ['1', '2', '3', '4', '5'].map((n) => ({ text: `${n}⭐`, value: n })),
    },
  ])
  .onFinish(({ params, answers }) => {
    const ticket = tickets.find((t) => t.id === Number(params.id));
    if (ticket) ticket.rating = answers.stars;
    return { text: 'Thanks for your feedback! 🙏' };
  });

// ---- wiring ---------------------------------------------------------------------------

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc AGENT_IDS=<your id> bun run examples/support.ts');
  process.exit(1);
}
if (!AGENTS.length) console.warn('No AGENT_IDS: nobody will get the tickets.');

const bot = new Bot(token);
const app = new EasyTG({
  relay: {
    // Customers can't send links (agents can).
    filter: ({ ctx }) => (isAgent(ctx.from?.id) || !/https?:\/\/|t\.me\//i.test(ctx.message?.text ?? '') ? true : '🔗 Links are not allowed here, sorry.'),
  },
})
  .register(newTicketNotice, take, connected, closedByOther, rate)
  .command('start', home, { description: 'Help center' })
  .command('support', newTicket, { description: 'Talk to a person' })
  .command('tickets', queue, { description: 'Waiting tickets (agents)', chats: 'private' })
  .command('close', close, { description: 'End the support chat' });

// A customer who blocked the bot can't get messages anymore: tell the agent.
app.on('relayEnd', async ({ reason, ctx }) => {
  if (reason === 'unreachable') await ctx?.reply('⚠️ The customer is no longer reachable. The ticket was closed.');
});

bot.use(app);
bot.catch((err) => console.error('Bot error:', err.error));
await app.syncCommands(bot);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });
