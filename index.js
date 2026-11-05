require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const reportChannelId = process.env.PROMO_REPORT_CHANNEL_ID;
const dataFile = path.join(__dirname, 'promo-data.json');
const reportTimezone = 'Africa/Cairo';
const readOnlyPermissionNames = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessages',
  'SendTTSMessages',
  'AddReactions',
  'AttachFiles',
  'EmbedLinks',
  'MentionEveryone',
  'UseExternalEmojis',
  'UseExternalStickers',
  'UseApplicationCommands',
  'ManageMessages',
  'ManageChannels',
  'ManageWebhooks',
  'ManageThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'SendMessagesInThreads',
  'CreateInstantInvite',
  'PinMessages',
  'BypassSlowmode',
  'Connect',
  'Speak',
  'Stream',
  'PrioritySpeaker',
  'MuteMembers',
  'DeafenMembers',
  'MoveMembers',
  'UseVAD',
  'RequestToSpeak',
  'UseEmbeddedActivities',
  'UseSoundboard',
  'UseExternalSounds',
  'SetVoiceChannelStatus',
  'SendVoiceMessages',
  'SendPolls',
  'UseExternalApps',
];

if (!token) {
  process.exit(1);
}

let data = { guilds: {} };
let writes = Promise.resolve();
let messages = Promise.resolve();
const reportsInProgress = new Set();
const pendingRemovals = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function loadData() {
  try {
    const saved = JSON.parse(await fs.readFile(dataFile, 'utf8'));

    if (
      !saved
      || typeof saved !== 'object'
      || !saved.guilds
      || typeof saved.guilds !== 'object'
      || Array.isArray(saved.guilds)
    ) {
      throw new Error('Promo data must contain a guilds object.');
    }

    data = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function saveData() {
  const write = async () => {
    const tempFile = `${dataFile}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tempFile, dataFile);
  };
  const save = writes.then(write, write);

  writes = save;
  return save;
}

function getLocalParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: reportTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function getLocalDate(date) {
  const { year, month, day } = getLocalParts(date);
  return `${year}-${month}-${day}`;
}

function isInReportWindow(value, date = null) {
  if (!value) {
    return false;
  }

  if (!date) {
    return true;
  }

  const parts = getLocalParts(new Date(value));
  return `${parts.year}-${parts.month}-${parts.day}` === date
    && Number(parts.hour) >= 12;
}

function getPreviousOverwrite(channel, userId) {
  const overwrite = channel.permissionOverwrites.cache.get(userId);
  if (!overwrite) {
    return null;
  }

  return {
    allow: overwrite.allow.toArray().filter((name) => readOnlyPermissionNames.includes(name)),
    deny: overwrite.deny.toArray().filter((name) => readOnlyPermissionNames.includes(name)),
  };
}

function getOverwriteRestoreOptions(previous) {
  return Object.fromEntries(readOnlyPermissionNames.map((name) => [
    name,
    previous?.allow.includes(name) ? true : previous?.deny.includes(name) ? false : null,
  ]));
}

function getReadOnlyOverwriteOptions() {
  return Object.fromEntries(readOnlyPermissionNames.map((name) => [
    name,
    name === 'ViewChannel' || name === 'ReadMessageHistory',
  ]));
}

async function getTicketChannel(channelId) {
  try {
    return await client.channels.fetch(channelId);
  } catch (error) {
    if (error.code === 10003) {
      return null;
    }
    throw error;
  }
}

async function applyTicketOwnerAccess(ticket) {
  const access = ticket.ownerAccess;
  if (!access) {
    return;
  }

  const channel = await getTicketChannel(access.channelId);
  if (!channel?.permissionOverwrites?.edit) {
    return;
  }

  await channel.permissionOverwrites.edit(access.ownerId, getReadOnlyOverwriteOptions());
}

async function restoreTicketOwnerAccess(ticket) {
  const access = ticket.ownerAccess;
  if (!access) {
    return;
  }

  const channel = await getTicketChannel(access.channelId);
  if (!channel?.permissionOverwrites?.edit) {
    return;
  }

  await channel.permissionOverwrites.edit(
    access.ownerId,
    getOverwriteRestoreOptions(access.previousOverwrite),
  );
}

function addCommissionBack(guildData, ticket) {
  if (!ticket.settledAt || !Number.isSafeInteger(ticket.commissionCents)) {
    return;
  }

  const balance = guildData.balances?.[ticket.promoOwnerId];
  if (!Number.isSafeInteger(balance) || balance < ticket.commissionCents) {
    throw new Error('Can’t remove this data because the promo balance doesn’t match.');
  }

  guildData.balances[ticket.promoOwnerId] = balance - ticket.commissionCents;
  if (guildData.balances[ticket.promoOwnerId] === 0) {
    delete guildData.balances[ticket.promoOwnerId];
  }
}

async function removePromo(guildData, code) {
  const promo = guildData.promos?.[code];
  if (!promo) {
    return false;
  }

  for (const [channelId, ticket] of Object.entries(guildData.tickets ?? {})) {
    if (ticket.promoCode !== code) {
      continue;
    }

    await restoreTicketOwnerAccess(ticket);
    addCommissionBack(guildData, ticket);
    delete guildData.tickets[channelId];
  }

  delete guildData.promos[code];
  return true;
}

async function removeTodayData(guildData, day) {
  const codesCreatedToday = Object.entries(guildData.promos ?? {})
    .filter(([, promo]) => isInReportWindow(promo.createdAt, day))
    .map(([code]) => code);

  for (const code of codesCreatedToday) {
    await removePromo(guildData, code);
  }

  for (const [channelId, ticket] of Object.entries(guildData.tickets ?? {})) {
    if (isInReportWindow(ticket.usedAt, day)) {
      await restoreTicketOwnerAccess(ticket);
      addCommissionBack(guildData, ticket);
      delete guildData.tickets[channelId];
      const promo = guildData.promos?.[ticket.promoCode];
      if (promo) {
        promo.redemptions = (promo.redemptions ?? []).filter((use) => (
          use.channelId !== channelId || use.usedAt !== ticket.usedAt
        ));
      }
      continue;
    }

    if (isInReportWindow(ticket.settledAt, day)) {
      addCommissionBack(guildData, ticket);
      delete ticket.amountCents;
      delete ticket.commissionCents;
      delete ticket.settledBy;
      delete ticket.settledAt;
    }
  }

  if (guildData.dailyReports) {
    delete guildData.dailyReports[day];
  }
}

async function confirmRemoval(message, action) {
  const guildId = message.guild.id;
  const savedGuild = data.guilds[guildId];
  if (!savedGuild) {
    await message.reply('There’s nothing to delete here.');
    return;
  }

  const backup = JSON.parse(JSON.stringify(savedGuild));
  try {
    if (action.type === 'code') {
      if (!await removePromo(savedGuild, action.code)) {
        await message.reply(`I can’t find \`${action.code}\`.`);
        return;
      }
    } else if (action.type === 'today') {
      await removeTodayData(savedGuild, action.day);
    } else {
      for (const ticket of Object.values(savedGuild.tickets ?? {})) {
        await restoreTicketOwnerAccess(ticket);
      }
      delete data.guilds[guildId];
    }

    await saveData();
  } catch {
    data.guilds[guildId] = backup;
    let accessNeedsChecking = false;
    for (const ticket of Object.values(backup.tickets ?? {})) {
      try {
        await applyTicketOwnerAccess(ticket);
      } catch {
        accessNeedsChecking = true;
      }
    }
    await message.reply(
      accessNeedsChecking
        ? 'Couldn’t save that change. I put the data back, but an admin should check the ticket permissions.'
        : 'Couldn’t save that change, so nothing was deleted.',
    );
    return;
  }

  if (action.type === 'code') {
    await message.reply(`Deleted \`${action.code}\` and its saved activity.`);
  } else if (action.type === 'today') {
    await message.reply(`Deleted today’s promo data for ${action.day}.`);
  } else {
    await message.reply('Deleted all promo codes, tickets and balances for this server.');
  }
}

function getReportText(guildData, date = null) {
  const promos = Object.entries(guildData.promos ?? {});
  const tickets = Object.values(guildData.tickets ?? {});
  const settlements = tickets.filter((ticket) => (
    ticket.promoCode && ticket.settledAt
    && (date ? isInReportWindow(ticket.settledAt, date) : true)
  ));
  const promoRows = promos.map(([code, promo]) => {
    const uses = (promo.redemptions ?? []).filter((use) => (
      !date || isInReportWindow(use.usedAt, date)
    ));
    const codeSettlements = settlements.filter((ticket) => ticket.promoCode === code);
    const ticketCents = codeSettlements.reduce((sum, ticket) => sum + ticket.amountCents, 0);
    const cutCents = codeSettlements.reduce((sum, ticket) => sum + ticket.commissionCents, 0);
    const createdToday = date && isInReportWindow(promo.createdAt, date);

    return {
      code,
      promo,
      uses,
      codeSettlements,
      ticketCents,
      cutCents,
      createdToday,
    };
  }).filter((row) => (
    !date || row.createdToday || row.uses.length || row.codeSettlements.length
  ));

  const totalCents = settlements.reduce((sum, ticket) => sum + ticket.amountCents, 0);
  const cutCents = settlements.reduce((sum, ticket) => sum + ticket.commissionCents, 0);
  const allUses = promoRows.reduce((sum, row) => sum + row.uses.length, 0);
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const lines = [
    date ? `Promo stats — ${date} (12pm–12am Cairo time)` : 'Promo stats so far',
    `${promoRows.length} code${promoRows.length === 1 ? '' : 's'} · ${allUses} use${allUses === 1 ? '' : 's'}`,
    `Tickets: ${money(totalCents)} · Promo cuts: ${money(cutCents)}`,
  ];

  if (!promoRows.length) {
    lines.push('', date ? 'Nothing to report for today.' : 'No promo codes have been made yet.');
  } else {
    lines.push('', 'Codes');
    for (const row of promoRows) {
      const owner = row.promo.ownerId ? `<@${row.promo.ownerId}>` : 'no owner';
      const fresh = row.createdToday ? ' · made today' : '';
      lines.push(
        `+${row.code}${fresh} — ${owner}`,
        `  ${row.uses.length} use${row.uses.length === 1 ? '' : 's'} · `
          + `${row.codeSettlements.length} ticket${row.codeSettlements.length === 1 ? '' : 's'}`
          + ` · ${money(row.ticketCents)} sales · ${money(row.cutCents)} earned`,
      );
    }
  }

  if (!date) {
    const balances = Object.entries(guildData.balances ?? {});
    if (balances.length) {
      lines.push('', 'Balances');
      for (const [userId, cents] of balances) {
        lines.push(`<@${userId}> — ${money(cents)}`);
      }
    }
  }

  return lines;
}

async function sendReport(channel, guildData, date = null) {
  let chunk = '';
  for (const line of getReportText(guildData, date)) {
    const next = chunk ? `${chunk}\n${line}` : line;
    if (next.length > 1900) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      chunk = line;
    } else {
      chunk = next;
    }
  }

  if (chunk) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

async function sendDailyReport(day) {
  if (!reportChannelId || reportsInProgress.has(day)) {
    return;
  }

  reportsInProgress.add(day);
  try {
    const channel = await client.channels.fetch(reportChannelId);
    if (!channel?.isTextBased() || typeof channel.send !== 'function' || !channel.guild) {
      throw new Error('The promo report channel must be a server text channel.');
    }

    const guildData = data.guilds[channel.guild.id] ??= {
      promos: {},
      tickets: {},
      balances: {},
      dailyReports: {},
    };
    guildData.dailyReports ??= {};

    if (guildData.dailyReports[day]) {
      return;
    }

    await sendReport(channel, guildData, day);
    guildData.dailyReports[day] = new Date().toISOString();
    await saveData();
  } finally {
    reportsInProgress.delete(day);
  }
}

function startDailyReports() {
  if (!reportChannelId) {
    return;
  }

  const check = () => {
    const now = new Date();
    const today = getLocalDate(now);
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const day = yesterday.toISOString().slice(0, 10);

    sendDailyReport(day).catch(() => {
      process.exitCode = 1;
    });
  };

  check();
  setInterval(check, 30_000);
}

async function onMessage(message) {
  if (message.author.bot || !message.guild) {
    return;
  }

  const content = message.content.trim();

  const removeCommand = content.match(/^\+remove(?:\s+(.+))?$/i);
  if (removeCommand) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await message.reply('You need to be an admin to delete promo data.');
      return;
    }

    const pendingKey = `${message.guild.id}:${message.author.id}:${message.channelId}`;
    const pending = pendingRemovals.get(pendingKey);

    if (removeCommand[1]?.trim().toLowerCase() === 'confirm') {
      if (!pending || pending.expiresAt < Date.now()) {
        pendingRemovals.delete(pendingKey);
        await message.reply('That delete request timed out. Run it again if you still want to delete it.');
        return;
      }

      pendingRemovals.delete(pendingKey);
      await confirmRemoval(message, pending.action);
      return;
    }

    const target = removeCommand[1]?.trim();
    if (!target) {
      await message.reply('Try `+remove <code>`, `+remove data` or `+remove all`.');
      return;
    }

    const guildData = data.guilds[message.guild.id];
    let action;
    let warning;
    if (target.toLowerCase() === 'data') {
      action = { type: 'today', day: getLocalDate(new Date()) };
      warning = 'today’s promo activity, from 12pm to midnight Cairo time';
    } else if (target.toLowerCase() === 'all') {
      action = { type: 'all' };
      warning = 'every promo code, ticket and balance on this server';
    } else {
      const code = target.toLowerCase();
      if (!guildData?.promos?.[code]) {
        await message.reply(`I can’t find a \`${code}\` code.`);
        return;
      }
      action = { type: 'code', code };
      warning = `\`${code}\`, all its uses and ticket totals`;
    }

    pendingRemovals.set(pendingKey, {
      action,
      expiresAt: Date.now() + 60_000,
    });
    await message.reply(
      `Heads up, this wipes ${warning}. Type \`+remove confirm\` here in the next minute if you wanna go ahead.`,
    );
    return;
  }

  if (content === '+data' || content === '+All') {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await message.reply('You need to be an admin to see the reports.');
      return;
    }

    if (!reportChannelId) {
      await message.reply('Add the report room ID to `PROMO_REPORT_CHANNEL_ID` in your `.env` first.');
      return;
    }

    const reportChannel = await client.channels.fetch(reportChannelId);
    if (
      !reportChannel?.isTextBased()
      || typeof reportChannel.send !== 'function'
      || reportChannel.guildId !== message.guild.id
    ) {
      await message.reply('That report room isn’t a text channel in this server.');
      return;
    }

    const guildData = data.guilds[message.guild.id] ?? {
      promos: {},
      tickets: {},
      balances: {},
    };
    const date = content === '+data' ? getLocalDate(new Date()) : null;
    await sendReport(reportChannel, guildData, date);

    if (reportChannel.id !== message.channelId) {
      await message.reply(`Sent it to <#${reportChannel.id}>.`);
    }
    return;
  }

  const promoCommand = content.match(/^\+promo(?:\s+(.+))?$/i);

  if (promoCommand) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await message.reply('You need to be an admin to add a code.');
      return;
    }

    const creationArgs = promoCommand[1]?.trim().match(/^([a-z0-9_-]{1,32})\s+<@!?(\d+)>$/i);
    const code = creationArgs?.[1].toLowerCase();
    const ownerId = creationArgs?.[2];
    const owner = ownerId ? message.mentions.users.get(ownerId) : null;

    if (!code || code === 'promo' || !owner || owner.bot || message.mentions.users.size !== 1) {
      await message.reply('Use `+promo <code> @person` and tag one real person.');
      return;
    }

    const guildId = message.guild.id;
    const isNewGuild = !data.guilds[guildId];
    const guildData = data.guilds[guildId] ??= { promos: {}, tickets: {}, balances: {} };
    guildData.promos ??= {};
    guildData.tickets ??= {};
    guildData.balances ??= {};

    if (guildData.promos[code]) {
      await message.reply(`There’s already a \`${code}\` code.`);
      return;
    }

    guildData.promos[code] = {
      ownerId: owner.id,
      ownerName: owner.tag,
      createdBy: message.author.id,
      createdAt: new Date().toISOString(),
      redemptions: [],
    };

    try {
      await saveData();
    } catch {
      delete guildData.promos[code];
      if (isNewGuild) {
        delete data.guilds[guildId];
      }
      await message.reply('Couldn’t save the code. Try again.');
      return;
    }

    await message.reply(`Added \`${code}\`. It’s ready to use.`);
    return;
  }

  const amountCommand = content.match(/^\+\s*\$?(\d+(?:\.\d{1,2})?)$/);

  if (amountCommand) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await message.reply('Only an admin can add the ticket total.');
      return;
    }

    const [wholeDollars, fractionalDollars = ''] = amountCommand[1].split('.');
    const amountCents = Number(wholeDollars) * 100 + Number(fractionalDollars.padEnd(2, '0'));

    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      await message.reply('That amount doesn’t look right. Try `+5` or `+5.50`.');
      return;
    }

    const guildData = data.guilds[message.guild.id];
    const ticket = guildData?.tickets?.[message.channelId];

    if (!ticket?.promoCode || !ticket.promoOwnerId) {
      await message.reply('There’s no promo code on this ticket.');
      return;
    }

    if (ticket.settledAt) {
      await message.reply('This ticket’s already been paid out.');
      return;
    }

    const commissionCents = Math.round(amountCents / 4);
    const currentBalanceCents = guildData.balances?.[ticket.promoOwnerId] ?? 0;
    const hadBalance = Object.hasOwn(guildData.balances ?? {}, ticket.promoOwnerId);

    if (
      !Number.isSafeInteger(currentBalanceCents)
      || !Number.isSafeInteger(currentBalanceCents + commissionCents)
    ) {
      await message.reply('That balance is too big to update. Ask another admin to check it.');
      return;
    }

    const settlement = {
      amountCents,
      commissionCents,
      settledBy: message.author.id,
      settledAt: new Date().toISOString(),
    };

    guildData.balances ??= {};
    guildData.balances[ticket.promoOwnerId] = currentBalanceCents + commissionCents;
    Object.assign(ticket, settlement);

    try {
      await saveData();
    } catch {
      if (hadBalance) {
        guildData.balances[ticket.promoOwnerId] = currentBalanceCents;
      } else {
        delete guildData.balances[ticket.promoOwnerId];
      }
      delete ticket.amountCents;
      delete ticket.commissionCents;
      delete ticket.settledBy;
      delete ticket.settledAt;
      await message.reply('Couldn’t save that. Try again.');
      return;
    }

    const formatUsd = (cents) => `$${(cents / 100).toFixed(2)}`;
    await message.reply({
      content: `Ticket total: ${formatUsd(amountCents)}. `
        + `<@${ticket.promoOwnerId}> gets ${formatUsd(commissionCents)}. `
        + `Their balance is ${formatUsd(guildData.balances[ticket.promoOwnerId])}.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const redemptionCommand = content.match(/^\+([a-z0-9_-]{1,32})$/i);

  if (!redemptionCommand) {
    return;
  }

  const code = redemptionCommand[1].toLowerCase();
  const guildData = data.guilds[message.guild.id];
  const promo = guildData?.promos?.[code];

  if (!promo) {
    return;
  }

  if (!promo.ownerId) {
    await message.reply(`\`${code}\` doesn’t have an owner linked to it.`);
    return;
  }

  guildData.tickets ??= {};
  const existingTicket = guildData.tickets[message.channelId];

  if (existingTicket?.settledAt) {
    await message.reply('This ticket’s already been paid out, so you can’t add a code now.');
    return;
  }

  if (existingTicket?.promoCode) {
    await message.reply(
      `This ticket already has \`${existingTicket.promoCode}\` on it. `
      + 'Only one code per ticket.',
    );
    return;
  }

  const channel = message.channel;
  if (
    !channel.isTextBased()
    || channel.isThread?.()
    || !channel.permissionOverwrites?.edit
  ) {
    await message.reply('This code only works in a regular text ticket.');
    return;
  }

  const previousOverwrite = getPreviousOverwrite(channel, promo.ownerId);
  try {
    await channel.permissionOverwrites.edit(promo.ownerId, getReadOnlyOverwriteOptions());
  } catch {
    await message.reply('I couldn’t give the code owner view-only access, so I didn’t add the code.');
    return;
  }

  const previousTicket = existingTicket ? { ...existingTicket } : null;
  const ticket = existingTicket ?? {};
  guildData.tickets[message.channelId] = ticket;
  Object.assign(ticket, {
    promoCode: code,
    promoOwnerId: promo.ownerId,
    usedBy: message.author.id,
    usedAt: new Date().toISOString(),
    ownerAccess: {
      ownerId: promo.ownerId,
      channelId: channel.id,
      previousOverwrite,
    },
  });

  promo.redemptions.push({
    userId: message.author.id,
    channelId: message.channelId,
    usedAt: new Date().toISOString(),
  });

  try {
    await saveData();
  } catch {
    promo.redemptions.pop();
    if (previousTicket) {
      guildData.tickets[message.channelId] = previousTicket;
    } else {
      delete guildData.tickets[message.channelId];
    }
    try {
      await restoreTicketOwnerAccess(ticket);
      await message.reply('Couldn’t save that code use, so I removed the view access again.');
    } catch {
      await message.reply('Couldn’t save the code use, and I couldn’t remove the owner’s ticket access. Ask an admin to check the channel permissions.');
    }
    return;
  }

  await message.reply(
    `Added \`${code}\` to this ticket. The code owner can view it now, but can’t send messages.`,
  );
}

client.once(Events.ClientReady, () => {
  startDailyReports();
});

client.on(Events.Error, () => {
  process.exitCode = 1;
});

client.on(Events.MessageCreate, (message) => {
  messages = messages.then(() => onMessage(message)).catch(() => {
    process.exitCode = 1;
  });
});

loadData().then(() => client.login(token)).catch(() => {
  process.exitCode = 1;
});