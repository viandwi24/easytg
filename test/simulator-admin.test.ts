import { describe, expect, test } from 'bun:test';
import { InputFile } from 'grammy';
import { TelegramSimulator } from '../packages/simulator/src';

function setup(options: { botAdmin?: boolean; type?: 'group' | 'supergroup' } = {}) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const bob = sim.addUser({ first_name: 'Bob' });
  const group = sim.createGroup({ title: 'Team', members: [sim.user.id, bob.id], ...options });
  return { sim, bot, bob, group };
}

describe('chat settings', () => {
  test('setChatTitle: a new_chat_title service message, and getChat shows the title', async () => {
    const { sim, bot, group } = setup();
    let seen: string | undefined;
    expect(await bot.api.setChatTitle(group.id, 'Team 2')).toBe(true);
    const last = sim.last(group.id)!;
    expect(last.message.new_chat_title).toBe('Team 2');
    expect(last.fromBot).toBe(true);
    expect((await bot.api.getChat(group.id)).title).toBe('Team 2');
    await expect(bot.api.setChatTitle(group.id, 'Team 2')).rejects.toThrow('chat title is not modified');
    await expect(bot.api.setChatTitle(group.id, '  ')).rejects.toThrow('chat title is empty');
    bot.on('message', (ctx) => void (seen = ctx.chat.title));
    await sim.send('hi', { chat: group.id });
    expect(seen).toBe('Team 2');
  });

  test('admin methods need an admin bot with the right', async () => {
    const { bot, group, sim } = setup({ botAdmin: false });
    await expect(bot.api.setChatTitle(group.id, 'X')).rejects.toThrow('not enough rights to change chat title');
    await expect(bot.api.exportChatInviteLink(group.id)).rejects.toThrow('not enough rights to manage chat invite link');
    const other = sim.createGroup({ title: 'Other' });
    other.members.get(sim.botInfo.id)!.rights = { can_change_info: false };
    await expect(bot.api.setChatDescription(other.id, 'x')).rejects.toThrow('not enough rights');
    await sim.send('hi');
    await expect(bot.api.setChatTitle(sim.user.id, 'x')).rejects.toThrow("isn't available for private chats");
  });

  test('setChatDescription and setChatPermissions show in getChat', async () => {
    const { bot, group } = setup();
    expect((await bot.api.getChat(group.id)).permissions?.can_send_messages).toBe(true);
    await bot.api.setChatDescription(group.id, 'Our team');
    await expect(bot.api.setChatDescription(group.id, 'Our team')).rejects.toThrow('chat description is not modified');
    await bot.api.setChatPermissions(group.id, { can_send_messages: true, can_send_polls: true });
    const chat = await bot.api.getChat(group.id);
    expect(chat.description).toBe('Our team');
    expect(chat.permissions).toMatchObject({ can_send_messages: true, can_send_polls: true, can_send_photos: false, can_invite_users: false });
  });

  test('without can_send_messages, members cannot write; admins can', async () => {
    const { sim, bot, bob, group } = setup();
    await bot.api.setChatPermissions(group.id, { can_send_messages: false });
    await expect(sim.send('hi', { chat: group.id, user: bob.id })).rejects.toThrow("can't send messages");
    await sim.send('hi', { chat: group.id }); // the creator
  });

  test('other media and previews imply sending messages unless independent', async () => {
    const { bot, group } = setup();
    await bot.api.setChatPermissions(group.id, { can_send_other_messages: true });
    expect((await bot.api.getChat(group.id)).permissions).toMatchObject({ can_send_messages: true, can_send_photos: true });
    await bot.api.setChatPermissions(group.id, { can_send_other_messages: true }, { use_independent_chat_permissions: true });
    expect((await bot.api.getChat(group.id)).permissions).toMatchObject({ can_send_messages: false, can_send_other_messages: true });
  });

  test('setChatPhoto and deleteChatPhoto: service messages, and getChat has the photo', async () => {
    const { sim, bot, group } = setup();
    await expect(bot.api.setChatPhoto(group.id, 'some-file-id' as never)).rejects.toThrow('there is no photo in the request');
    await bot.api.setChatPhoto(group.id, new InputFile(new Uint8Array([1, 2, 3]), 'team.jpg'));
    expect(sim.last(group.id)!.message.new_chat_photo?.length).toBeGreaterThan(0);
    const photo = (await bot.api.getChat(group.id)).photo!;
    expect(photo.big_file_id).toBe(group.photo!.fileId);
    expect((await bot.api.getFile(photo.big_file_id)).file_path).toBeString();
    await bot.api.deleteChatPhoto(group.id);
    expect(sim.last(group.id)!.message.delete_chat_photo).toBe(true);
    expect((await bot.api.getChat(group.id)).photo).toBeUndefined();
    await expect(bot.api.deleteChatPhoto(group.id)).rejects.toThrow('CHAT_NOT_MODIFIED');
  });

  test('setChatStickerSet takes known sets, in supergroups', async () => {
    const { sim, bot, group } = setup();
    await expect(bot.api.setChatStickerSet(group.id, 'nope')).rejects.toThrow('STICKERSET_INVALID');
    sim.addStickerSet({ name: 'team_by_demo_bot' });
    await bot.api.setChatStickerSet(group.id, 'team_by_demo_bot');
    expect(await bot.api.getChat(group.id)).toMatchObject({ sticker_set_name: 'team_by_demo_bot', can_set_sticker_set: true });
    await bot.api.deleteChatStickerSet(group.id);
    expect((await bot.api.getChat(group.id)).sticker_set_name).toBeUndefined();
    const basic = sim.createGroup({ title: 'Basic', type: 'group' });
    await expect(bot.api.setChatStickerSet(basic.id, 'team_by_demo_bot')).rejects.toThrow('only for supergroups');
  });
});

describe('members', () => {
  test('custom titles for admins and tags for members appear in getChatMember', async () => {
    const { sim, bot, bob, group } = setup();
    await expect(bot.api.setChatAdministratorCustomTitle(group.id, bob.id, 'Boss')).rejects.toThrow('user is not an administrator');
    await bot.api.promoteChatMember(group.id, bob.id, { can_pin_messages: true });
    await bot.api.setChatAdministratorCustomTitle(group.id, bob.id, 'Boss');
    expect(await bot.api.getChatMember(group.id, bob.id)).toMatchObject({ status: 'administrator', custom_title: 'Boss' });
    await expect(bot.api.setChatAdministratorCustomTitle(group.id, bob.id, 'x'.repeat(17))).rejects.toThrow('ADMIN_RANK_INVALID');
    await expect(bot.api.setChatAdministratorCustomTitle(group.id, bob.id, '👑')).rejects.toThrow('ADMIN_RANK_EMOJI_NOT_ALLOWED');

    const carol = sim.addUser({ first_name: 'Carol' });
    await sim.join(group.id, carol.id);
    await bot.api.setChatMemberTag(group.id, carol.id, 'Design');
    expect(await bot.api.getChatMember(group.id, carol.id)).toMatchObject({ status: 'member', tag: 'Design' });
    await bot.api.setChatMemberTag(group.id, carol.id, '');
    expect(await bot.api.getChatMember(group.id, carol.id)).not.toHaveProperty('tag');
    await expect(bot.api.setChatMemberTag(group.id, bob.id, 'x')).rejects.toThrow('regular members');
  });

  test('banChatSenderChat / unbanChatSenderChat keep a list of banned channels', async () => {
    const { bot, group } = setup();
    await bot.api.banChatSenderChat(group.id, -100123);
    expect(group.bannedSenderChats).toEqual([-100123]);
    await bot.api.unbanChatSenderChat(group.id, -100123);
    expect(group.bannedSenderChats).toEqual([]);
  });

  test('getUserChatBoosts: nobody boosts in the simulator', async () => {
    const { bot, bob, group } = setup();
    expect(await bot.api.getUserChatBoosts(group.id, bob.id)).toEqual({ boosts: [] });
  });
});

describe('invite links and join requests', () => {
  test('exportChatInviteLink makes the primary link; exporting again revokes the old one', async () => {
    const { bot, group } = setup();
    const first = await bot.api.exportChatInviteLink(group.id);
    expect(first).toMatch(/^https:\/\/t\.me\/\+\w+$/);
    expect((await bot.api.getChat(group.id)).invite_link).toBe(first);
    const second = await bot.api.exportChatInviteLink(group.id);
    expect(second).not.toBe(first);
    expect((await bot.api.getChat(group.id)).invite_link).toBe(second);
    expect(group.inviteLinks!.find((l) => l.invite_link === first)!.is_revoked).toBe(true);
    const revoked = await bot.api.revokeChatInviteLink(group.id, second);
    expect(revoked).toMatchObject({ invite_link: second, is_primary: true, is_revoked: true });
    expect((await bot.api.getChat(group.id)).invite_link).not.toBe(second);
  });

  test('createChatInviteLink, editChatInviteLink and joining by link with a member limit', async () => {
    const { sim, bot, group } = setup();
    const link = await bot.api.createChatInviteLink(group.id, { name: 'Friends', member_limit: 1 });
    expect(link).toMatchObject({ name: 'Friends', member_limit: 1, is_primary: false, is_revoked: false, creates_join_request: false, creator: { id: sim.botInfo.id } });
    await expect(bot.api.createChatInviteLink(group.id, { member_limit: 1, creates_join_request: true })).rejects.toThrow("member_limit can't be specified");
    await expect(bot.api.editChatInviteLink(group.id, 'https://t.me/+nope', { name: 'x' })).rejects.toThrow('INVITE_HASH_INVALID');

    const joined: number[] = [];
    bot.on('message:new_chat_members', (ctx) => void joined.push(ctx.message.new_chat_members[0]!.id));
    const carol = sim.addUser({ first_name: 'Carol' });
    const dave = sim.addUser({ first_name: 'Dave' });
    await sim.joinByLink(link.invite_link, carol.id);
    expect(joined).toEqual([carol.id]);
    await expect(sim.joinByLink(link.invite_link, dave.id)).rejects.toThrow('member limit');

    const edited = await bot.api.editChatInviteLink(group.id, link.invite_link, { member_limit: 5, name: 'More friends' });
    expect(edited).toMatchObject({ member_limit: 5, name: 'More friends' });
    await sim.joinByLink(link.invite_link, dave.id);
    expect(joined).toEqual([carol.id, dave.id]);

    await bot.api.revokeChatInviteLink(group.id, link.invite_link);
    const erin = sim.addUser({ first_name: 'Erin' });
    await expect(sim.joinByLink(link.invite_link, erin.id)).rejects.toThrow('expired');
  });

  test('a link that needs approval sends a chat_join_request; approve adds the member', async () => {
    const { sim, bot, group } = setup();
    const link = await bot.api.createChatInviteLink(group.id, { creates_join_request: true });
    const carol = sim.addUser({ first_name: 'Carol' });
    const order: string[] = [];
    bot.on('chat_join_request', async (ctx) => {
      order.push(`request:${ctx.chatJoinRequest.invite_link?.invite_link === link.invite_link}`);
      expect(ctx.chatJoinRequest.invite_link?.pending_join_request_count).toBe(1);
      // The bot may write to the user before they started it (user_chat_id).
      await ctx.api.sendMessage(ctx.chatJoinRequest.user_chat_id, 'Welcome! Approving you now.');
      await ctx.approveChatJoinRequest(ctx.from.id);
      order.push('approved');
    });
    bot.on('message:new_chat_members', () => void order.push('joined'));
    await sim.joinByLink(link.invite_link, carol.id);
    expect(order).toEqual(['request:true', 'approved', 'joined']);
    expect(group.members.get(carol.id)?.status).toBe('member');
    expect(sim.last(group.id)!.message.new_chat_members?.[0]?.id).toBe(carol.id);
    expect(sim.last(carol.id)!.message.text).toBe('Welcome! Approving you now.');
    await expect(bot.api.approveChatJoinRequest(group.id, carol.id)).rejects.toThrow('HIDE_REQUESTER_MISSING');
  });

  test('declineChatJoinRequest leaves the user out', async () => {
    const { sim, bot, group } = setup();
    const carol = sim.addUser({ first_name: 'Carol' });
    await sim.requestToJoin(group.id, carol.id, { bio: 'Designer' });
    expect(group.joinRequests?.get(carol.id)?.bio).toBe('Designer');
    await expect(bot.api.sendMessage(carol.id, 'hi')).resolves.toBeDefined(); // while the request is pending
    await bot.api.declineChatJoinRequest(group.id, carol.id);
    expect(group.members.get(carol.id)).toBeUndefined();
    expect(group.joinRequests?.size).toBe(0);
    await expect(bot.api.declineChatJoinRequest(group.id, carol.id)).rejects.toThrow('HIDE_REQUESTER_MISSING');
    await expect(bot.api.sendMessage(carol.id, 'hi again')).rejects.toThrow("can't initiate conversation"); // processed: no more
  });

  test('join request queries: answerChatJoinRequestQuery and sendChatJoinRequestWebApp', async () => {
    const { sim, bot, group } = setup();
    const carol = sim.addUser({ first_name: 'Carol' });
    const dave = sim.addUser({ first_name: 'Dave' });
    const opened: string[] = [];
    sim.on('open', (e) => void opened.push(`${e.kind}:${e.userId}:${e.url}`));
    bot.on('chat_join_request', async (ctx) => {
      const queryId = ctx.chatJoinRequest.query_id!;
      if (ctx.from.id === carol.id) await ctx.api.answerChatJoinRequestQuery(queryId, 'approve');
      else await ctx.api.sendChatJoinRequestWebApp(queryId, 'https://example.com/verify');
    });
    await sim.requestToJoin(group.id, carol.id, { query: true });
    expect(group.members.get(carol.id)?.status).toBe('member');
    await sim.requestToJoin(group.id, dave.id, { query: true });
    expect(opened).toEqual([`webApp:${dave.id}:https://example.com/verify`]);
    expect(group.joinRequests?.has(dave.id)).toBe(true); // still pending: the Mini App decides
    await expect(bot.api.answerChatJoinRequestQuery('unknown', 'approve')).rejects.toThrow('query is too old');
    await bot.api.approveChatJoinRequest(group.id, dave.id);
    expect(group.members.get(dave.id)?.status).toBe('member');
  });

  test('channels: subscription links and quiet approvals', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const channel = sim.createChannel({ title: 'News' });
    const link = await bot.api.createChatSubscriptionInviteLink(channel.id, 2592000, 100, { name: 'Premium' });
    expect(link).toMatchObject({ subscription_period: 2592000, subscription_price: 100, name: 'Premium' });
    expect((await bot.api.editChatSubscriptionInviteLink(channel.id, link.invite_link, { name: 'VIP' })).name).toBe('VIP');
    await expect(bot.api.createChatSubscriptionInviteLink(channel.id, 60, 100)).rejects.toThrow('SUBSCRIPTION_PERIOD_INVALID');
    const group = sim.createGroup({ title: 'Team' });
    await expect(bot.api.createChatSubscriptionInviteLink(group.id, 2592000, 100)).rejects.toThrow('only for channels');

    const carol = sim.addUser({ first_name: 'Carol' });
    await sim.requestToJoin(channel.id, carol.id);
    await bot.api.approveChatJoinRequest(channel.id, carol.id);
    expect(channel.members.get(carol.id)?.status).toBe('member');
    expect(channel.messages).toHaveLength(0);
  });
});
