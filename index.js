require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require('discord.js');
const Airtable = require('airtable');
const { createTranscript } = require('discord-html-transcripts');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const PORT = process.env.PORT || 3000;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const TRANSCRIPTS_CHANNEL_ID = process.env.TRANSCRIPTS_CHANNEL_ID;
const ADMIN_ROLE_IDS = ['1100568786744119376', '1150412914696650786'];

const sellerMap = new Map();

client.once('ready', async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);

  const channel = await client.channels.fetch(VERIFY_CHANNEL_ID);
  if (channel && channel.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle('🔐 Verify Deal Access')
      .setDescription('Click the button below and enter your **Claim ID** to unlock access to your deal channel.')
      .setColor(0xFFED00);

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('verify_access')
        .setLabel('Verify Deal Access')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({ embeds: [embed], components: [button] });
  }
});

// ... All other handlers (claim-deal, interactions, confirm/cancel logic) remain unchanged ...

client.on(Events.MessageCreate, async message => {
  if (
    message.channel.name.toUpperCase().startsWith('ORD-') &&
    message.attachments.size > 0
  ) {
    const data = sellerMap.get(message.channel.id);
    if (!data?.sellerId) return;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_deal')
        .setLabel('Confirm Deal')
        .setStyle(ButtonStyle.Success)
    );

    await message.channel.send({
      content: 'Admin: click below to confirm the deal.',
      components: [row]
    });
  }

  // ✅ NEW: Finish command
  if (message.content === '!finish' && message.channel.name.toLowerCase().startsWith('ord-')) {
    const memberRoles = message.member.roles.cache.map(r => r.id);
    const isAdmin = ADMIN_ROLE_IDS.some(id => memberRoles.includes(id));
    if (!isAdmin) {
      return message.reply('❌ You are not authorized to use this command.');
    }

    await message.channel.send(
      '✅ This deal is now finished. Thank you for this deal — we look forward to dealing with you again!\n🕒 This ticket will automatically close in 1 hour.'
    );

    setTimeout(async () => {
      try {
        const transcriptFileName = `transcript-${message.channel.name}.html`;
        const transcript = await createTranscript(message.channel, {
          limit: -1,
          returnBuffer: false,
          fileName: transcriptFileName
        });

        const transcriptsChannel = await client.channels.fetch(TRANSCRIPTS_CHANNEL_ID);
        if (transcriptsChannel && transcriptsChannel.isTextBased()) {
          await transcriptsChannel.send({
            content: `📜 Final transcript for finished deal **${message.channel.name}**`,
            files: [transcript]
          });
        }

        await message.channel.delete();
      } catch (err) {
        console.error(`❌ Error finishing deal ${message.channel.name}:`, err);
      }
    }, 3600000); // 1 hour in milliseconds
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
