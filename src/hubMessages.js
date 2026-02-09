const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require("discord.js");

function registerHubMessages(ctx) {
  const { client, env } = ctx;

  const {
    ALL_QUICK_DEALS_CHANNEL_ID,
    ALL_WTBS_CHANNEL_ID,
    QUICK_DEALS_WEBSITE_URL,
    WTBS_WEBSITE_URL,
    SELLER_REG_CHANNEL_ID,
  } = env;

  async function ensureMessageInChannel({
    channelId,
    title,
    descriptionLines,
    buttonLabel,
    buttonUrl,
    color = 0xffd300,
  }) {
    if (!channelId) return;

    const ch = await client.channels.fetch(String(channelId)).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(descriptionLines.join("\n"))
      .setColor(color);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(buttonLabel).setStyle(ButtonStyle.Link).setURL(buttonUrl)
    );

    const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = recent?.find(
      (m) => m.author?.id === client.user.id && m.embeds?.[0]?.title === title
    );

    if (existing) {
      await existing.edit({ embeds: [embed], components: [row] }).catch(() => {});
      return existing;
    } else {
      return await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
    }
  }

  async function ensureAllQuickDealsMessage() {
    if (!ALL_QUICK_DEALS_CHANNEL_ID || !QUICK_DEALS_WEBSITE_URL) return;

    const sellerReg = SELLER_REG_CHANNEL_ID ? `<#${SELLER_REG_CHANNEL_ID}>` : "the seller registration channel";

    return ensureMessageInChannel({
      channelId: ALL_QUICK_DEALS_CHANNEL_ID,
      title: "⚡ Browse All Active Quick Deals",
      descriptionLines: [
        "Quick Deals are instant, first-come, first-served opportunities with payouts that increase over time. Besides our Quick Deals channels on Discord, all our active Quick Deals can also be viewed in one place, including:",
        "",
        "• 🔎 Product • SKU • Size",
        "• 🪙 Current Payout",
        "• ⚡ Direct redirect link to claim",
        "",
        "Click below to view the full Quick Deals list and secure deals before someone else grabs them.",
        "See an item you want to deal? Just click on the item and it redirects you to the "Claim Deal" Webhook here on Discord!",
        "",
        "**Remember:**",
        `You need a **Seller ID** to claim any Quick Deal. If you don’t have one yet, go to ${sellerReg} and create your profile in seconds!`,
      ],
      buttonLabel: "📥 View All Quick Deals",
      buttonUrl: QUICK_DEALS_WEBSITE_URL,
      color: 0xffd300,
    });
  }

  async function ensureAllWTBsMessage() {
    if (!ALL_WTBS_CHANNEL_ID || !WTBS_WEBSITE_URL) return;

    const sellerReg = SELLER_REG_CHANNEL_ID ? `<#${SELLER_REG_CHANNEL_ID}>` : "the seller registration channel";

    return ensureMessageInChannel({
      channelId: ALL_WTBS_CHANNEL_ID,
      title: "🔥 Browse All Active WTB’s",
      descriptionLines: [
        "We source a large number of items daily that you can provide. In addition to our Discord WTB channels, all active WTBs can also be browsed and offered on through our website, including:",
        "",
        "• 🔎 Product • SKU • Size",
        "• 🪙 Current Lowest Offer / Starting Price",
        "• ⚡ Direct option to offer",
        "",
        "Click below to view the full WTB list and find deals you can sell into.",
        "",
        "**Remember:**",
        `You need a **Seller ID** to offer on any item. If you don’t have one yet, go to ${sellerReg} and create your profile in seconds!`,
      ],
      buttonLabel: "📥 View All WTBs",
      buttonUrl: WTBS_WEBSITE_URL,
      color: 0xffd300,
    });
  }

  client.once(Events.ClientReady, async () => {
    await ensureAllQuickDealsMessage();
    await ensureAllWTBsMessage();
    console.log("✅ Hub messages ensured (Quick Deals + WTBs).");
  });
}

module.exports = { registerHubMessages };
