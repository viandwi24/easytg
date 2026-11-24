import { describe, expect, test } from 'bun:test';
import { GrammyError } from 'grammy';
import { GENERAL_TOPIC, TelegramSimulator } from '../packages/simulator/src';

describe('channels', () => {
  test('the owner posts: the bot gets channel_post without from, and answers in the channel', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const channel = sim.createChannel({ title: 'News' });
    const seen: unknown[] = [];
    bot.on('channel_post', async (ctx) => {
      seen.push({ from: ctx.from, sender: ctx.channelPost.sender_chat?.id, text: ctx.channelPost.text });
      await ctx.reply('Posted by the bot');
    });
    await sim.send('Hello subscribers', { chat: channel.id });
    expect(seen).toEqual([{ from: undefined, sender: channel.id, text: 'Hello subscribers' }]);
    const last = sim.last(channel.id)!;
    expect(last.fromBot).toBe(true);
    expect(last.message.from).toBeUndefined();
    expect(last.message.sender_chat?.id).toBe(channel.id);
  });

  test('subscribers read but cannot post; they join without a message', async () => {
    const sim = new TelegramSimulator();
    sim.createBot();
    const alice = sim.addUser({ first_name: 'Alice' });
    const channel = sim.createChannel({ title: 'News' });
    await sim.join(channel.id, alice.id);
    expect(channel.members.get(alice.id)?.status).toBe('member');
    expect(channel.messages).toHaveLength(0);
    expect(sim.send('hi', { chat: channel.id, user: alice.id })).rejects.toThrow("can't post in the channel");
  });

  test('a bot that is not an admin cannot post', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const channel = sim.createChannel({ title: 'News', botAdmin: false });
    expect(bot.api.sendMessage(channel.id, 'x')).rejects.toThrow('need administrator rights');
  });
});

describe('forum topics', () => {
  test('createForumTopic: the topic id is the id of its service message; messages carry it', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const forum = sim.createGroup({ title: 'Team', forum: true });
    const topic = await bot.api.createForumTopic(forum.id, 'Bugs');
    expect(forum.topics).toHaveLength(1);
    expect(topic.message_thread_id).toBe(forum.topics![0]!.id);
    const sent = await bot.api.sendMessage(forum.id, 'In the topic', { message_thread_id: topic.message_thread_id });
    expect(sent.message_thread_id).toBe(topic.message_thread_id);
    expect(sent.is_topic_message).toBe(true);
    expect(sent.chat).toMatchObject({ is_forum: true });
    expect(bot.api.sendMessage(forum.id, 'x', { message_thread_id: 999 })).rejects.toThrow('message thread not found');
  });

  test('a user creates a topic and writes in it; replies stay in their topic', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const forum = sim.createGroup({ title: 'Team', forum: true });
    const created: string[] = [];
    bot.on('message:forum_topic_created', (ctx) => void created.push(ctx.message.forum_topic_created.name));
    bot.on('message:text', (ctx) => ctx.reply(`thread ${ctx.message.message_thread_id ?? 'general'}`, { reply_parameters: { message_id: ctx.message.message_id } }));
    const topic = await sim.createTopic(forum.id, 'Ideas');
    expect(created).toEqual(['Ideas']);
    await sim.send('hi', { chat: forum.id, thread: topic.id });
    expect(sim.last(forum.id)!.message).toMatchObject({ text: `thread ${topic.id}`, message_thread_id: topic.id, is_topic_message: true });
    await sim.send('in general', { chat: forum.id, thread: GENERAL_TOPIC });
    expect(sim.last(forum.id)!.message.text).toBe('thread general');
    expect(sim.last(forum.id)!.message.message_thread_id).toBeUndefined();
  });

  test('closed topics, deleting topics, errors outside forums', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const alice = sim.addUser({ first_name: 'Alice' });
    const forum = sim.createGroup({ title: 'Team', forum: true, members: [sim.user.id, alice.id] });
    const { message_thread_id: id } = await bot.api.createForumTopic(forum.id, 'Old');
    await bot.api.closeForumTopic(forum.id, id);
    expect(sim.topic(forum.id, id)?.closed).toBe(true);
    expect(sim.send('x', { chat: forum.id, user: alice.id, thread: id })).rejects.toThrow('closed');
    expect(bot.api.closeForumTopic(forum.id, id)).rejects.toThrow('TOPIC_NOT_MODIFIED');
    await bot.api.deleteForumTopic(forum.id, id);
    expect(forum.topics).toHaveLength(0);
    expect(forum.messages.some((m) => m.message.message_thread_id === id)).toBe(false);
    const group = sim.createGroup({ title: 'Plain' });
    const error = await bot.api.createForumTopic(group.id, 'x').catch((e: GrammyError) => e);
    expect((error as GrammyError).description).toContain('not a forum');
  });
});

test('latencyMs takes a [min, max] range', async () => {
  const sim = new TelegramSimulator({ latencyMs: [40, 60] });
  const bot = sim.createBot();
  const started = Date.now();
  await bot.api.getMe();
  const took = Date.now() - started;
  expect(took).toBeGreaterThanOrEqual(38);
  expect(took).toBeLessThan(200);
});
