/*
 * /broadcast-tickets: one announcement embed into every open deal ticket.
 *
 * A deal ticket is open for as long as its channel exists: closing, finishing
 * or cancelling a deal deletes the channel. So "open tickets" are the text
 * channels named ord-... inside the deal categories (Quick Deal and Snapshot).
 *
 * Flow: command -> modal (title, text, image) -> ephemeral preview with the
 * target list -> Send / Cancel -> one message per channel, ~1 s apart ->
 * report. Every embed carries a short ref of its content in the footer; a
 * channel that already has a bot message with that ref is skipped, so running
 * the command twice, or again after a crash halfway, sends nobody a duplicate.
 */
const crypto = require('crypto');
const {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const COMMAND_NAME = 'broadcast-tickets';
const BRAND_GOLD = 0xffc400;
const SEND_DELAY_MS = 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const DEDUP_SCAN_LIMIT = 100;

const REQUIRED_PERMS = [
  ['ViewChannel', PermissionsBitField.Flags.ViewChannel],
  ['SendMessages', PermissionsBitField.Flags.SendMessages],
  ['EmbedLinks', PermissionsBitField.Flags.EmbedLinks],
  ['ReadMessageHistory', PermissionsBitField.Flags.ReadMessageHistory]
];

// Readable via /portal-status, so a missing command can be diagnosed without the Render logs.
const registrationStatus = { state: 'pending', error: null, at: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function contentRef({ title, text, imageUrl }) {
  return crypto
    .createHash('sha1')
    .update(`${title}\u0000${text}\u0000${imageUrl}`)
    .digest('hex')
    .slice(0, 8);
}

function footerText(ref) {
  return `Kickz Caviar · ref ${ref}`;
}

function buildEmbed({ title, text, imageUrl, ref }) {
  const embed = new EmbedBuilder()
    .setColor(BRAND_GOLD)
    .setDescription(text)
    .setFooter({ text: footerText(ref) });
  if (title) embed.setTitle(title);
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

function isOpenDealTicket(channel, categoryIds) {
  return (
    channel &&
    channel.type === ChannelType.GuildText &&
    categoryIds.has(String(channel.parentId || '')) &&
    String(channel.name || '').toLowerCase().startsWith('ord-')
  );
}

function missingPerms(channel, me) {
  const perms = channel.permissionsFor(me);
  if (!perms) return REQUIRED_PERMS.map(([name]) => name);
  return REQUIRED_PERMS.filter(([, flag]) => !perms.has(flag)).map(([name]) => name);
}

async function alreadyHasBroadcast(channel, botId, ref) {
  const messages = await channel.messages.fetch({ limit: DEDUP_SCAN_LIMIT });
  const needle = footerText(ref);
  return messages.some(
    (m) => m.author?.id === botId && m.embeds.some((e) => e.footer?.text === needle)
  );
}

function listChannelNames(channels, max = 1500) {
  let out = '';
  for (let i = 0; i < channels.length; i++) {
    const line = `#${channels[i].name}\n`;
    if (out.length + line.length > max) {
      out += `…and ${channels.length - i} more\n`;
      break;
    }
    out += line;
  }
  return out.trim();
}

function registerBroadcastTickets({ client, env, adminRoleIds, getCategoryIds }) {
  const GUILD_ID = env.GUILD_ID;
  const LOG_CHANNEL_ID = env.BROADCAST_LOG_CHANNEL_ID || env.TRANSCRIPTS_CHANNEL_ID || '';
  const pending = new Map(); // id -> { userId, title, text, imageUrl, ref, channelIds, testMode, createdAt }

  const isAdmin = (member) => {
    const roles = member?.roles?.cache;
    return Boolean(roles && adminRoleIds.some((id) => id && roles.has(id)));
  };

  function prunePending() {
    const now = Date.now();
    for (const [id, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(id);
  }

  async function logBroadcast(line) {
    console.log(`📣 BROADCAST ${line}`);
    if (!LOG_CHANNEL_ID) return;
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch?.isTextBased()) {
      await ch.send({ content: `📣 ${line}`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
    }
  }

  client.once(Events.ClientReady, async () => {
    if (!GUILD_ID) {
      console.warn('⚠️ /broadcast-tickets not registered: GUILD_ID missing.');
      Object.assign(registrationStatus, { state: 'skipped', error: 'GUILD_ID missing', at: new Date().toISOString() });
      return;
    }
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      // create() upserts by name and leaves any other command alone.
      await guild.commands.create({
        name: COMMAND_NAME,
        description: 'Send one announcement to every open deal ticket (staff only).',
        // Hidden for members without Manage Server; adjustable per role in
        // Server Settings -> Integrations without a code change.
        defaultMemberPermissions: PermissionsBitField.Flags.ManageGuild,
        dmPermission: false,
        options: [
          {
            name: 'test_channel',
            description: 'Send only to this channel, to try it out first.',
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildText],
            required: false
          }
        ]
      });
      console.log(`✅ /${COMMAND_NAME} registered.`);
      Object.assign(registrationStatus, { state: 'registered', error: null, at: new Date().toISOString() });
    } catch (err) {
      console.error(`❌ Could not register /${COMMAND_NAME}:`, err?.message || err);
      Object.assign(registrationStatus, { state: 'failed', error: `${err?.code || ''} ${err?.message || err}`.trim(), at: new Date().toISOString() });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      /* ---------- /broadcast-tickets -> modal ---------- */
      if (interaction.isChatInputCommand() && interaction.commandName === COMMAND_NAME) {
        if (!isAdmin(interaction.member)) {
          await interaction.reply({ content: '❌ You are not allowed to use this command.', flags: MessageFlags.Ephemeral });
          return;
        }
        const testChannel = interaction.options.getChannel('test_channel');
        const modal = new ModalBuilder()
          .setCustomId(`bct_modal:${testChannel ? testChannel.id : ''}`)
          .setTitle(testChannel ? 'Broadcast (TEST, one channel)' : 'Broadcast to open deal tickets')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('title')
                .setLabel('Title (optional)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(256)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('text')
                .setLabel('Message')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(4000)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('image')
                .setLabel('Image URL (optional)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(1000)
            )
          );
        await interaction.showModal(modal);
        return;
      }

      /* ---------- modal -> preview ---------- */
      if (interaction.isModalSubmit() && interaction.customId.startsWith('bct_modal:')) {
        if (!isAdmin(interaction.member)) {
          await interaction.reply({ content: '❌ You are not allowed to use this command.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const title = interaction.fields.getTextInputValue('title').trim();
        const text = interaction.fields.getTextInputValue('text').trim();
        const imageUrl = interaction.fields.getTextInputValue('image').trim();
        if (imageUrl) {
          let ok = false;
          try {
            ok = ['http:', 'https:'].includes(new URL(imageUrl).protocol);
          } catch (_) {}
          if (!ok) {
            await interaction.editReply({ content: '❌ The image URL is not a valid link. Run the command again.' });
            return;
          }
        }

        const testChannelId = interaction.customId.slice('bct_modal:'.length);
        const guild = interaction.guild;
        let targets;
        if (testChannelId) {
          const ch = await guild.channels.fetch(testChannelId).catch(() => null);
          targets = ch ? [ch] : [];
        } else {
          const categoryIds = new Set(getCategoryIds().map(String));
          const all = await guild.channels.fetch();
          targets = [...all.values()]
            .filter((ch) => isOpenDealTicket(ch, categoryIds))
            .sort((a, b) => a.name.localeCompare(b.name));
        }

        if (!targets.length) {
          await interaction.editReply({ content: '⚠️ No open deal tickets found. Nothing to send.' });
          return;
        }

        prunePending();
        const ref = contentRef({ title, text, imageUrl });
        const id = crypto.randomBytes(6).toString('hex');
        pending.set(id, {
          userId: interaction.user.id,
          title,
          text,
          imageUrl,
          ref,
          channelIds: targets.map((c) => c.id),
          testMode: Boolean(testChannelId),
          createdAt: Date.now()
        });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`bct_send:${id}`).setLabel(`Send to ${targets.length}`).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`bct_cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
          content:
            `**Preview${testChannelId ? ' (TEST)' : ''}.** This will go to **${targets.length}** ` +
            `ticket${targets.length === 1 ? '' : 's'}. Nothing is sent until you press Send.\n` +
            `Tickets that already got this exact message are skipped.\n\n${listChannelNames(targets)}`,
          embeds: [buildEmbed({ title, text, imageUrl, ref })],
          components: [row]
        });
        return;
      }

      /* ---------- cancel ---------- */
      if (interaction.isButton() && interaction.customId.startsWith('bct_cancel:')) {
        pending.delete(interaction.customId.slice('bct_cancel:'.length));
        await interaction.update({ content: '✖️ Broadcast cancelled. Nothing was sent.', embeds: [], components: [] });
        return;
      }

      /* ---------- send ---------- */
      if (interaction.isButton() && interaction.customId.startsWith('bct_send:')) {
        const id = interaction.customId.slice('bct_send:'.length);
        const job = pending.get(id);
        if (!job) {
          await interaction.update({
            content: '⚠️ This preview expired or was already sent. Run the command again.',
            embeds: [],
            components: []
          });
          return;
        }
        if (job.userId !== interaction.user.id || !isAdmin(interaction.member)) {
          await interaction.reply({ content: '❌ Only the person who made this preview can send it.', flags: MessageFlags.Ephemeral });
          return;
        }
        pending.delete(id); // a second click can't start a second run

        const total = job.channelIds.length;
        await interaction.update({ content: `⏳ Sending… 0/${total}`, embeds: [], components: [] });

        const guild = interaction.guild;
        const me = guild.members.me || (await guild.members.fetchMe());
        const embed = buildEmbed(job);
        const sent = [];
        const skipped = [];
        const failed = [];

        for (let i = 0; i < total; i++) {
          const channelId = job.channelIds[i];
          const channel = await guild.channels.fetch(channelId).catch(() => null);
          const label = channel ? `#${channel.name}` : `<${channelId}>`;

          if (!channel) {
            skipped.push(`${label}: ticket closed in the meantime`);
          } else {
            const missing = missingPerms(channel, me);
            if (missing.length) {
              failed.push(`${label}: missing permission ${missing.join(', ')}`);
            } else {
              let done = false;
              for (let attempt = 1; attempt <= 2 && !done; attempt++) {
                try {
                  if (await alreadyHasBroadcast(channel, client.user.id, job.ref)) {
                    skipped.push(`${label}: already has this message`);
                  } else {
                    // discord.js waits out 429s itself; this retry covers other hiccups.
                    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
                    sent.push(label);
                  }
                  done = true;
                } catch (err) {
                  if (attempt === 2 || err?.status === 403 || err?.status === 404) {
                    failed.push(`${label}: ${err?.message || err}`);
                    done = true;
                  } else {
                    await sleep(3000);
                  }
                }
              }
            }
          }

          if ((i + 1) % 10 === 0 && i + 1 < total) {
            await interaction.editReply({ content: `⏳ Sending… ${i + 1}/${total}` }).catch(() => {});
          }
          if (i + 1 < total) await sleep(SEND_DELAY_MS);
        }

        const lines = [
          `✅ Broadcast finished${job.testMode ? ' (TEST)' : ''}: sent **${sent.length}** / skipped **${skipped.length}** / failed **${failed.length}**`
        ];
        if (skipped.length) lines.push('', '**Skipped**', ...skipped);
        if (failed.length) lines.push('', '**Failed**', ...failed);
        const report = lines.join('\n').slice(0, 1990);

        // The interaction token lasts 15 minutes; a long run may outlive it.
        await interaction.editReply({ content: report }).catch(async () => {
          await interaction.followUp({ content: report, flags: MessageFlags.Ephemeral }).catch(() => {});
        });

        const preview = (job.title ? `${job.title}: ` : '') + job.text.replace(/\s+/g, ' ');
        await logBroadcast(
          `${job.testMode ? 'TEST ' : ''}by <@${interaction.user.id}> (ref ${job.ref}): ` +
            `sent ${sent.length} / skipped ${skipped.length} / failed ${failed.length}` +
            (failed.length ? `\nFailed: ${failed.join('; ')}` : '') +
            `\nMessage: ${preview.slice(0, 300)}${preview.length > 300 ? '…' : ''}`
        );
        return;
      }
    } catch (err) {
      console.error('❌ broadcast-tickets error:', err);
      const msg = { content: '⚠️ Something went wrong with the broadcast. Check the logs.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply(msg).catch(() => {});
    }
  });
}

module.exports = { registerBroadcastTickets, registrationStatus, isOpenDealTicket, contentRef, buildEmbed, listChannelNames };
