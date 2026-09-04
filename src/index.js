require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { registerAffiliateInvites } = require("./affiliateInvites");
const { registerLeaderboards } = require("./leaderboards");
const { registerMembersBackfill } = require("./backfillMembers");
const { registerHubMessages } = require("./hubMessages");
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
const QUICK_DEALS_AIRTABLE_URL =
  'https://kickzcaviar.com';
const PARTNER_INVITE_URL = 'https://discord.gg/GZY9NBpYUS';
/* ---------------- EXPRESS SETUP ---------------- */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: (_origin, cb) => cb(null, true),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With']
  })
);
app.options(/.*/, cors());
/* ---------------- DISCORD CLIENT ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ]
});
// crash guards
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
client.on('error', (err) => {
  console.error('Client error:', err);
});
/* ---------------- AIRTABLE + ENV ---------------- */
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
registerAffiliateInvites({ client, base, env: process.env });
registerLeaderboards({ client, base, env: process.env });
registerMembersBackfill({ client, base, env: process.env });
registerHubMessages({ client, base, env: process.env });
const PORT = process.env.PORT || 3000;

// De portal weet wie bij welk Discord ID hoort en verstuurt de mail voor het
// claimen van een profiel. Deze bot vraagt het daar op in plaats van bij elke
// Quick Deal een Seller ID uit te vragen.
const KC_PORTAL_BASE_URL = process.env.KC_PORTAL_BASE_URL || 'https://kickzcaviar.com';
const KC_PORTAL_SECRET = process.env.KC_PORTAL_SECRET || '';
const SUPPORT_CHANNEL_MENTION = '<#1444838494760603769>';
const PORTAL_SIGNUP_URL = `${KC_PORTAL_BASE_URL.replace(/\/$/, '')}/signup`;

// Wat iemand had ingevuld toen bleek dat zijn Discord nog nergens aan hangt,
// zodat hij na het claimen verder kan waar hij was. In geheugen: het hoeft een
// herstart niet te overleven, dan klikt hij gewoon opnieuw.
const pendingQuickClaims = new Map();

// Discord geeft drie seconden om op een knopklik te antwoorden, en showModal
// kan niet uitgesteld worden. Een korte cache houdt de veelvoorkomende klik
// (bekende seller) op nul netwerkverkeer.
const sellerLookupCache = new Map();
const SELLER_LOOKUP_TTL_MS = 5 * 60 * 1000;

function forgetSellerLookup(discordId) {
  sellerLookupCache.delete(discordId);
}

// Geeft het lookup-resultaat terug, of null als het niet op tijd lukte. Bij
// null gaat de aanroeper door met de gewone modal en vangt de submit-handler
// het alsnog af.
async function lookupSellerCached(discordId) {
  const cached = sellerLookupCache.get(discordId);

  if (cached && Date.now() - cached.at < SELLER_LOOKUP_TTL_MS) return cached.value;

  try {
    const value = await Promise.race([
      portalPost('/api/internal/seller-by-discord', { discord_id: discordId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
    ]);

    sellerLookupCache.set(discordId, { value, at: Date.now() });
    return value;
  } catch (err) {
    console.error('seller-by-discord lookup failed:', err.message);
    return null;
  }
}


const NOT_LINKED_EMBED = {
  title: '⚠️ We could not find your seller profile',
  description: [
    "This Discord account isn't connected to a seller profile, so we don't know who's making this offer.",
    '',
    "**Sold with us before?** Use *Link my Seller ID* — you'll need your Seller ID and the email on your profile.",
    '',
    '**New here?** Use *Create a profile* to sign up.',
    '',
    'Neither of these? Open a ticket in <#1444838494760603769> and we will sort it out.'
  ].join('\n'),
  // Zelfde geel als de rest van de onboarding-berichten.
  color: 0xffd300
};

function notLinkedComponents() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Link my Seller ID', custom_id: 'claim_start' },
        { type: 2, style: 5, label: 'Create a profile', url: PORTAL_SIGNUP_URL }
      ]
    }
  ];
}

async function dmNotLinked(user) {
  try {
    await user.send({ embeds: [NOT_LINKED_EMBED], components: notLinkedComponents() });
  } catch (err) {
    // DM's uit staan is geen fout; het ephemeral antwoord staat er ook nog.
    console.warn('Could not DM not-linked notice:', err.message);
  }
}

function buildClaimProfileModal() {
  const modal = new ModalBuilder().setCustomId('claim_profile_modal').setTitle('Link your Seller ID');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('claim_seller_id')
        .setLabel('Your Seller ID (numbers only)')
        .setPlaceholder('00001')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('claim_email')
        .setLabel('The email on your seller profile')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  );

  return modal;
}


// Zonder deze twee valt de seller-lookup stil terug op de oude route: de
// gebruiker krijgt dan alsnog het offerformulier en pas bij het versturen te
// horen dat er iets mis is. Die terugval is met opzet (een platte portal mag
// niet alles blokkeren), maar een ontbrekende env-var hoort zichtbaar te zijn.
if (!KC_PORTAL_SECRET) {
  console.error(
    '❌ KC_PORTAL_SECRET ontbreekt — seller-lookup en profiel claimen werken niet. ' +
      'Zet KC_PORTAL_SECRET en KC_PORTAL_BASE_URL op deze service.'
  );
} else {
  console.log(`✅ Portal-koppeling actief: ${KC_PORTAL_BASE_URL}`);
}

async function portalPost(path, body) {
  if (!KC_PORTAL_SECRET) throw new Error('KC_PORTAL_SECRET is missing');

  const response = await fetch(`${KC_PORTAL_BASE_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-kc-secret': KC_PORTAL_SECRET },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(data.error || `Portal call failed (${response.status})`);

  return data;
}

// Soepel inlezen: Discord-modals kennen geen dropdown en geen tekenmasker, dus
// hoofdletters, spaties en koppeltekens moeten hier opgevangen worden.
function normalizeQuickVatType(raw) {
  const clean = String(raw ?? '').toLowerCase().replace(/[\s._-]/g, '');

  if (!clean) return null;
  if (clean === 'margin' || clean === 'marge' || clean === 'm') return 'Margin';
  if (/^(vat|btw)?21%?$/.test(clean)) return 'VAT21';
  if (/^(vat|btw)?0+%?$/.test(clean)) return 'VAT0';

  return null;
}
// Discord
const GUILD_ID = process.env.GUILD_ID;
const DEAL_CATEGORY_IDS = (process.env.DEAL_CATEGORY_IDS || process.env.CATEGORY_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const QUICK_DEALS_CHANNEL_ID = process.env.QUICK_DEALS_CHANNEL_ID; // channel where Quick Deals listing embeds live
const TRANSCRIPTS_CHANNEL_ID = process.env.TRANSCRIPTS_CHANNEL_ID;
// Brand → channel routing (Option A)
const QUICK_DEALS_DEFAULT_CHANNEL_ID =
  process.env.QUICK_DEALS_DEFAULT_CHANNEL_ID || process.env.QUICK_DEALS_CHANNEL_ID;
// Label Handling Lojiq WMS)
const LOJIQ_WMS_BASE_URL = process.env.LOJIQ_WMS_BASE_URL || '';
function safeLower(s) {
  return String(s || '').trim().toLowerCase();
}
function toChannelSlug(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-') // only keep a-z 0-9 and -
    .replace(/-+/g, '-')         // collapse multiple dashes
    .replace(/^-|-$/g, '');      // trim leading/trailing dash
}
function getOrderIdFromChannelName(channelName) {
  const raw = String(channelName || '').toUpperCase().trim(); // "ORD-00001-5678"
  const parts = raw.split('-').filter(Boolean);              // ["ORD","00001","5678"]
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;   // "ORD-00001"
  return raw;
}
// Optional: normalize common variations (keeps your mapping small)
function normalizeBrand(brand) {
  const b = safeLower(brand);
  if (!b) return '';
  if (b.includes('jordan')) return 'jordan';
  if (b.includes('nike')) return 'nike';
  if (b.includes('adidas')) return 'adidas';
  if (b.includes('new balance')) return 'new balance';
  if (b.includes('asics')) return 'asics';
  if (b.includes('ugg')) return 'ugg';
  return b;
}
function parseBrandChannelMap() {
  const raw = process.env.QUICK_DEALS_BRAND_CHANNEL_MAP || '';
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [k, v] of Object.entries(obj || {})) {
      if (!k || !v) continue;
      map.set(normalizeBrand(k), String(v).trim());
    }
    return map;
  } catch (e) {
    console.warn('⚠️ QUICK_DEALS_BRAND_CHANNEL_MAP is not valid JSON:', e.message);
    return new Map();
  }
}
const BRAND_CHANNEL_MAP = parseBrandChannelMap();

/*
 * Snapshots get their own category and their own per-brand channels, so they
 * get their own map. Same shape as QUICK_DEALS_BRAND_CHANNEL_MAP: a JSON
 * object of brand -> channel id, with a default channel for brands that have
 * no room of their own.
 */
function parseSnapshotBrandChannelMap() {
  const raw = process.env.SNAPSHOT_DEALS_BRAND_CHANNEL_MAP || '';
  if (!raw.trim()) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(raw)).map(([k, v]) => [safeLower(k), String(v)]));
  } catch (e) {
    console.warn('⚠️ SNAPSHOT_DEALS_BRAND_CHANNEL_MAP is not valid JSON:', e.message);
    return new Map();
  }
}

const SNAPSHOT_BRAND_CHANNEL_MAP = parseSnapshotBrandChannelMap();

/*
 * Snapshot deal channels get their own categories.
 *
 * Falls back to the Quick Deal categories when none are set, so a missing
 * env var means channels land somewhere sensible rather than nowhere.
 */
const SNAPSHOT_DEAL_CATEGORY_IDS = (process.env.SNAPSHOT_DEAL_CATEGORY_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

function snapshotDealCategoryIds() {
  return SNAPSHOT_DEAL_CATEGORY_IDS.length ? SNAPSHOT_DEAL_CATEGORY_IDS : DEAL_CATEGORY_IDS;
}

const SNAPSHOT_DEALS_DEFAULT_CHANNEL_ID = process.env.SNAPSHOT_DEALS_DEFAULT_CHANNEL_ID;

function pickSnapshotChannelId(brand) {
  const key = normalizeBrand(brand);
  return SNAPSHOT_BRAND_CHANNEL_MAP.get(key) || SNAPSHOT_DEALS_DEFAULT_CHANNEL_ID;
}
function pickQuickDealsChannelId(brand) {
  const key = normalizeBrand(brand);
  return BRAND_CHANNEL_MAP.get(key) || QUICK_DEALS_DEFAULT_CHANNEL_ID;
}
// If we only stored Claim Message URL, we can extract the channel id from it
function extractChannelIdFromDiscordUrl(url) {
  // https://discord.com/channels/<guildId>/<channelId>/<messageId>
  const m = String(url || '').match(/discord\.com\/channels\/\d+\/(\d+)\/\d+/);
  return m ? m[1] : null;
}
// (kept for backward compatibility, but no longer used by /quick-deal/create-partners)
const PARTNER_QUICK_DEALS_CHANNEL_IDS = (process.env.PARTNER_QUICK_DEALS_CHANNEL_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
// Roles / permissions
const ADMIN_ROLE_IDS = ['942779423449579530', '1060615571118510191'];
const TRUSTED_SELLERS_ROLE_ID = process.env.TRUSTED_SELLERS_ROLE_ID;
// Webhook to Make (for Inventory Unit creation etc.)
const MAKE_QUICK_DEAL_WEBHOOK_URL = process.env.MAKE_QUICK_DEAL_WEBHOOK_URL || '';
/* ---------------- PARTNERS (Airtable) ---------------- */
/**
 * Uses the Partnerships table instead of env channel IDs.
 *
 * REQUIRED FIELDS in "Partnerships" table:
 * - "Active?" (checkbox)
 * - "Quick Deals Webhook URL" (text)  <-- preferred
 *
 * Optional fallback:
 * - "WTB Webhook URL" (text)          <-- if you want to reuse same webhook field
 */
const PARTNERS_TABLE_NAME = process.env.AIRTABLE_PARTNERS_TABLE || 'Partnerships';
const PARTNER_FIELD_ACTIVE = 'Active?';
const PARTNER_FIELD_QD_WEBHOOK = 'Quick Deals Webhook URL';
const PARTNER_FIELD_WTB_WEBHOOK_FALLBACK = 'WTB Webhook URL';
// In Unfulfilled Orders Log we will store: "partnerRecordId:messageId,partnerRecordId2:messageId2,..."
const ORDER_TABLE_NAME = 'Unfulfilled Orders Log';
const MEMBER_WTB_TABLE_NAME = 'Member WTBs';

/*
 * A snapshot can hang off either side of the house: a store order or a
 * member's want-to-buy. The caller says which, because only it knows.
 */
function snapshotTableFor(source) {
  return String(source || '').toLowerCase() === 'member_wtb'
    ? MEMBER_WTB_TABLE_NAME
    : ORDER_TABLE_NAME;
}
const ORDER_FIELD_CLAIMED_CHANNEL_ID = 'Claimed Channel ID';
const PARTNER_FIELD_LAST_QD_POST_AT = 'Last Post At';
const PARTNER_FIELD_INVITE_URL = 'Invite URL';
/* ---------------- RUNTIME STATE ---------------- */
const sellerMap = new Map(); // channelId -> {orderRecordId, sellerRecordId, sellerId, ...}
const uploadedImagesMap = new Map(); // channelId -> [imageUrls...]
async function fetchUpTo(channel, max = 500) {
  const collected = [];
  let beforeId;
  while (collected.length < max) {
    const batchSize = Math.min(100, max - collected.length);
    const batch = await channel.messages.fetch({
      limit: batchSize,
      ...(beforeId ? { before: beforeId } : {})
    });
    if (batch.size === 0) break;
    for (const m of batch.values()) collected.push(m);
    const oldest = batch.last();
    beforeId = oldest?.id;
    if (!beforeId) break;
  }
  return collected;
}
function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (v.length === 0) return '';
    const first = v[0];
    if (first == null) return '';
    if (typeof first === 'object') {
      if (first.text != null) return String(first.text);
      if (first.name != null) return String(first.name);
      if (first.value != null) return String(first.value);
    }
    return String(first);
  }
  return String(v);
}
// Validates a seller's chosen VAT type against their Sellers Database
// profile (VAT ID + Country). Returns null when allowed, or the exact
// block message when not. Rules: no VAT ID → Margin only; VAT ID + NL →
// no VAT0; VAT ID + non-NL → no VAT21. Margin always allowed. Mirrors
// validateSellerVatEligibility in the kickz-caviar portal and the wtb-bot
// so every offer/claim placement point enforces identical rules.
function validateSellerVatEligibility(sellerVatId, sellerCountry, chosenVatType) {
  const vat = String(chosenVatType || '').trim();
  if (vat === 'Margin') return null;

  const hasVatId = !!String(sellerVatId || '').trim();
  const country = String(sellerCountry || '').trim().toLowerCase();
  const isNl = country === 'netherlands' || country === 'nederland' || country === 'nl';

  if (!hasVatId) {
    return "You're not a registered company according to your profile. Please select Margin VAT Type or contact support.";
  }
  if (isNl && vat === 'VAT0') {
    return "As a Dutch company, you can't sell VAT0 to Kickz Caviar B.V.. Please select VAT21 or Margin VAT Type or contact support.";
  }
  if (!isNl && vat === 'VAT21') {
    return "As a Non-Dutch company, you can't sell VAT21 to Kickz Caviar B.V.. Please select VAT0 or Margin VAT Type or contact support.";
  }
  return null;
}
/*
 * The record behind a deal channel, whichever table it lives in.
 *
 * Channel names carry the order they belong to, and until snapshots arrived
 * that was always an ORD- in Unfulfilled Orders Log. A snapshot can hang off
 * a want-to-buy, whose channel is named MWTB-000449 - and looking that up in
 * the orders table finds nothing, which surfaced as "Missing claimed Seller
 * or Order ID" the first time the bot restarted mid-deal.
 *
 * Five places did this lookup by hand. One function now, so the next table
 * that joins the party is added once.
 */
async function findDealRecords(orderNumber) {
  const key = String(orderNumber || '').trim().toUpperCase();

  if (!key) return [];

  if (key.startsWith('MWTB-')) {
    return await base(MEMBER_WTB_TABLE_NAME)
      .select({ filterByFormula: `{Member WTB ID} = "${key}"`, maxRecords: 1 })
      .firstPage();
  }

  return await base(ORDER_TABLE_NAME)
    .select({ filterByFormula: `{Order ID} = "${key}"`, maxRecords: 1 })
    .firstPage();
}

async function pickCategoryWithSpace(guild, categoryIds) {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) return null;
  // Make sure cache is warm
  await guild.channels.fetch();
  // Count children per category
  const counts = new Map(); // parentId -> number of channels
  for (const ch of guild.channels.cache.values()) {
    const parentId = ch.parentId;
    if (!parentId) continue;
    counts.set(parentId, (counts.get(parentId) || 0) + 1);
  }
  // Discord category max is 50
  const MAX = 50;
  for (const id of categoryIds) {
    const cat = guild.channels.cache.get(id);
    if (!cat) continue;
    if (cat.type !== ChannelType.GuildCategory) continue;
    const used = counts.get(id) || 0;
    if (used < MAX) return cat;
  }
  return null;
}
/** Read active partners with a Quick Deals webhook URL */
async function getActiveQuickDealPartners() {
  const records = await base(PARTNERS_TABLE_NAME)
    .select({
      filterByFormula: `AND({${PARTNER_FIELD_ACTIVE}}=TRUE(), OR({${PARTNER_FIELD_QD_WEBHOOK}}!='', {${PARTNER_FIELD_WTB_WEBHOOK_FALLBACK}}!=''))`
    })
    .all();
  return records
    .map((rec) => {
      const qd = rec.get(PARTNER_FIELD_QD_WEBHOOK);
      const fallback = rec.get(PARTNER_FIELD_WTB_WEBHOOK_FALLBACK);
      const webhookUrl = (qd && String(qd).trim()) || (fallback && String(fallback).trim()) || '';
      return {
        id: rec.id,
        name: rec.get('Name') || rec.id,
        webhookUrl,
        inviteUrl: String(rec.get(PARTNER_FIELD_INVITE_URL) || '').trim()
      };
    })
    .filter((p) => !!p.webhookUrl);
}
/** Safely turn a webhook URL into a "PATCH message" URL */
function webhookEditUrl(webhookUrl, messageId) {
  // strip query params like ?wait=true if someone saved it like that
  const baseUrl = String(webhookUrl).split('?')[0].replace(/\/$/, '');
  return `${baseUrl}/messages/${messageId}`;
}
/* ---------------- DISCORD READY ---------------- */
client.once('ready', async () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);
  if (PARTNER_QUICK_DEALS_CHANNEL_IDS.length) {
    console.log('ℹ️ PARTNER_QUICK_DEALS_CHANNEL_IDS is set but Quick Deals partners now send via Airtable webhooks.');
  }
});
/* =================================================
   QUICK DEALS – LISTING EMBED CREATION & UPDATES
   ================================================= */
/**
 * POST /quick-deal/create
 *
 * Main Quick Deal in your own server
 */
// Opvraagbaar in plaats van alleen in de log. Zoeken in Render-logs is
// onbetrouwbaar gebleken als diagnose: de regel stond er wel in de code maar
// niet in de log. Dit geeft direct antwoord op de vraag die telt — draait de
// nieuwe code, en is de portal-koppeling geconfigureerd?
app.get('/portal-status', (_req, res) => {
  res.json({
    build: 'seller-lookup-v1',
    portal_base_url: KC_PORTAL_BASE_URL,
    portal_secret_set: !!KC_PORTAL_SECRET,
    node: process.version,
    started_at: new Date().toISOString()
  });
});

/*
 * A snapshot deal: one fixed price, one hour, claim or leave it.
 *
 * Where a Quick Deal climbs towards a maximum payout over time, this is the
 * opposite - a buyer has just committed to a price and we want the pair
 * today, so the number is the number and the clock is short. Short on
 * purpose: the buyer may find it elsewhere, and a claim twelve hours later
 * would close a deal nobody is waiting for any more.
 *
 * Creates OR refreshes. A counter that moves the price calls this again, and
 * the existing message is edited rather than a second one sent - five rounds
 * of haggling must not leave five embeds in a brand channel. The caller does
 * not have to know which case it is in.
 */
/*
 * Both scales, side by side, the way a Quick Deal embed shows them.
 *
 * The price we work with is VAT-inclusive, which is what a Margin seller
 * gets paid. A VAT0 seller invoices without VAT, so the same deal is worth
 * that figure divided by 1.21 to him. Showing only one number means half the
 * channel has to do the sum before they know whether it is worth claiming.
 */
/*
 * What a seller is actually paid, in his own VAT scale.
 *
 * Rounded down to the EUR 2.50 grid, exactly as getConsignmentSellerOfferPrice
 * does in the portal. That matters more than it looks: the consignors already
 * holding this pair were offered a grid number, and if a snapshot paid so much
 * as a euro more they would ignore their own offer and claim this instead.
 */
function snapshotPayoutFor(amount, vatType) {
  const raw = String(vatType).trim().toUpperCase() === 'VAT0'
    ? Number(amount) / 1.21
    : Number(amount);

  return Math.floor(raw / 2.5) * 2.5;
}

function formatSnapshotPayout(amount) {
  const incl = snapshotPayoutFor(amount, 'Margin');
  const vat0 = snapshotPayoutFor(amount, 'VAT0');

  return `€${incl} (Margin) / €${vat0} (VAT0)`;
}

/*
 * Quiet hours.
 *
 * A snapshot lives for an hour, so one posted at one in the morning expires
 * before anyone is awake to see it - and one of the stores does most of its
 * countering at night. Anything that lands in the quiet window is held as
 * Queued and posted by the sweep once the window closes, with its hour
 * starting then rather than at three in the morning.
 *
 * Amsterdam time explicitly, not the server's idea of local: this decides
 * when sellers are awake, and that does not move with a deploy region.
 */
const SNAPSHOT_QUIET_FROM = Number(process.env.SNAPSHOT_QUIET_FROM_HOUR || 22);
const SNAPSHOT_QUIET_UNTIL = Number(process.env.SNAPSHOT_QUIET_UNTIL_HOUR || 10);

function amsterdamHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam',
      hour: '2-digit',
      hour12: false
    }).format(date)
  );
}

function isSnapshotQuietHour(date = new Date()) {
  const hour = amsterdamHour(date);

  // The window wraps midnight, so "from 22 until 10" is two ranges.
  return SNAPSHOT_QUIET_FROM > SNAPSHOT_QUIET_UNTIL
    ? hour >= SNAPSHOT_QUIET_FROM || hour < SNAPSHOT_QUIET_UNTIL
    : hour >= SNAPSHOT_QUIET_FROM && hour < SNAPSHOT_QUIET_UNTIL;
}

const SNAPSHOT_MINUTES = Number(process.env.SNAPSHOT_DEAL_MINUTES || 60);

/*
 * Post a snapshot, or edit the one that is already up.
 *
 * Shared by the endpoint and the sweep, because the sweep posts the ones
 * that were queued overnight and must produce exactly the same embed. Reads
 * the product details from the record rather than a payload, so both callers
 * describe the deal the same way.
 */
async function postOrRefreshSnapshot({ tableName, recordId, record, payout }) {
  const fields = record.fields || {};

  const productName = String(fields['Product Name'] || '');
  const sku = String(fields['SKU'] || fields['SKU (Soft)'] || '');
  const size = String(fields['Size'] || '');
  const brand = String(fields['Brand'] || '');
  const picture = Array.isArray(fields['Picture']) && fields['Picture'][0]
    ? fields['Picture'][0].url
    : '';

  const targetChannelId = pickSnapshotChannelId(brand);

  if (!targetChannelId) throw new Error('Missing SNAPSHOT_DEALS_DEFAULT_CHANNEL_ID');
  if (!GUILD_ID) throw new Error('Missing GUILD_ID env');

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(targetChannelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error(`Snapshot channel not usable (brand="${brand}", channelId=${targetChannelId})`);
  }

  const expiresAt = new Date(Date.now() + SNAPSHOT_MINUTES * 60 * 1000);

  // Discord renders this as a live countdown, so the embed stays honest
  // without anyone editing it every minute.
  const expiryStamp = `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`;

  const embed = new EmbedBuilder()
    .setTitle('📸 Snapshot Deal')
    .setDescription(`**${productName || '-'}**
${sku || '-'}
${size || '-'}
${brand || '-'}`)
    .setColor(0xffed00)
    .addFields(
      { name: 'Payout', value: formatSnapshotPayout(payout), inline: true },
      { name: 'Expires', value: expiryStamp, inline: true }
    );

  if (picture) embed.setImage(picture);

  const source = tableName === MEMBER_WTB_TABLE_NAME ? 'member_wtb' : 'order';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`snapshot_claim:${source}:${recordId}`)
      .setLabel('Claim Deal')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setLabel('See All Deals')
      .setStyle(ButtonStyle.Link)
      .setURL(QUICK_DEALS_AIRTABLE_URL)
  );

  const existingChannelId = String(fields['Snapshot Channel ID'] || '');
  const existingMessageId = String(fields['Snapshot Message ID'] || '');
  const existingStatus = String(fields['Snapshot Status'] || '');

  let msg = null;
  let refreshed = false;

  if (existingMessageId && existingStatus === 'Active') {
    // Edit where it actually lives, even if the brand map has moved since.
    const home = existingChannelId === targetChannelId
      ? channel
      : await guild.channels.fetch(existingChannelId).catch(() => null);

    const previous = home ? await home.messages.fetch(existingMessageId).catch(() => null) : null;

    if (previous) {
      msg = await previous.edit({ embeds: [embed], components: [row] });
      refreshed = true;
    }
  }

  if (!msg) msg = await channel.send({ embeds: [embed], components: [row] });

  /*
    If the record cannot be written, the message must not survive.

    A snapshot whose fields never landed is a button with nothing behind it:
    the claim reads the record, finds no Active snapshot, and tells a seller
    it is no longer available - for a deal that was never available in the
    first place. Seen live on 4 September, when the fields existed on orders
    but not yet on want-to-buys.
  */
  try {
    await base(tableName).update(recordId, {
      'Snapshot Channel ID': msg.channelId,
      'Snapshot Message ID': msg.id,
      'Snapshot Price': payout,
      'Snapshot Expires At': expiresAt.toISOString(),
      'Snapshot Status': 'Active'
    });
  } catch (err) {
    if (!refreshed) await msg.delete().catch(() => null);

    throw new Error(
      `Could not write the snapshot back to ${tableName} (${recordId}): ${err.message}`
    );
  }

  console.log(
    `📸 Snapshot ${refreshed ? 'refreshed' : 'posted'} for ${recordId} ` +
      `(${tableName}, brand="${brand || '-'}") € ${payout} -> ${msg.channelId}/${msg.id}`
  );

  return { refreshed, channelId: msg.channelId, messageId: msg.id, expiresAt };
}

/*
 * The snapshot sweep: expire what is over, post what waited for morning.
 *
 * Deliberately driven by what the records say rather than by timers held in
 * memory - this process restarts on every deploy, and a snapshot that
 * quietly stopped expiring would leave a claimable price standing for a
 * buyer who has long since gone elsewhere.
 */
const SNAPSHOT_TABLES = [ORDER_TABLE_NAME, MEMBER_WTB_TABLE_NAME];

async function closeSnapshot(tableName, recordId, reason) {
  const record = await base(tableName).find(recordId).catch(() => null);

  if (!record) return false;

  const channelId = String(record.get('Snapshot Channel ID') || '');
  const messageId = String(record.get('Snapshot Message ID') || '');

  if (channelId && messageId && GUILD_ID) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const channel = await guild.channels.fetch(channelId);
      const message = channel && channel.isTextBased()
        ? await channel.messages.fetch(messageId).catch(() => null)
        : null;

      if (message) {
        const closedLine = {
          Claimed: '✅ Claimed by another seller.',
          Expired: '⌛ This snapshot has expired.',
          Cancelled: '🛑 This deal was cancelled.'
        }[reason];

        const embed = EmbedBuilder.from(message.embeds[0] || {})
          .setColor(0x808080)
          .setFooter({ text: closedLine });

        await message.edit({ embeds: [embed], components: [] });
      }
    } catch (err) {
      // A message we cannot reach is no reason to leave the record saying
      // Active: the status is what the portal and this sweep read.
      console.error(`Could not edit snapshot message for ${recordId}:`, err.message);
    }
  }

  await base(tableName).update(recordId, { 'Snapshot Status': reason });

  return true;
}

async function sweepSnapshots() {
  for (const tableName of SNAPSHOT_TABLES) {
    try {
      const live = await base(tableName)
        .select({
          filterByFormula: `OR({Snapshot Status} = 'Active', {Snapshot Status} = 'Queued')`,
          fields: [
            'Snapshot Status',
            'Snapshot Expires At',
            'Snapshot Price',
            'Snapshot Channel ID',
            'Snapshot Message ID',
            'Fulfillment Status',
            'Linked Inventory Unit',
            'Product Name',
            'SKU',
            'Size',
            'Brand',
            'Picture'
          ]
        })
        .all();

      for (const record of live) {
        const status = String(record.get('Snapshot Status') || '');

        /*
          Somebody else got there first.

          A consignor confirming, or a store accepting, takes the deal out of
          Outsource - and from that moment the snapshot is a button that can
          only refuse whoever presses it. Closing it here rather than waiting
          for the hour to run out is the difference between a seller seeing a
          grey card and a seller being told no.

          A claim closes its own snapshot on the spot, so anything still open
          here was overtaken by another route.

          This runs before the queued branch on purpose. A snapshot held back
          at ten in the evening is posted at ten the next morning, and eleven
          hours is long enough for a consignor to have answered in the
          meantime. Without this it would go up anyway, advertising a pair we
          had already bought.
        */
        const linkedUnit = record.get('Linked Inventory Unit');
        const hasUnit = Array.isArray(linkedUnit) && linkedUnit.length > 0;
        const fulfillment = String(record.get('Fulfillment Status') || '');

        if (hasUnit || (fulfillment && fulfillment !== 'Outsource')) {
          await closeSnapshot(tableName, record.id, hasUnit ? 'Claimed' : 'Cancelled');

          console.log(
            `📸 Snapshot closed for ${record.id} (${tableName}): order is ` +
              `${hasUnit ? 'already supplied' : `at ${fulfillment}`}.`
          );

          continue;
        }

        if (status === 'Queued') {
          if (isSnapshotQuietHour()) continue;

          const payout = Number(record.get('Snapshot Price') || 0);

          if (!(payout > 0)) continue;

          await postOrRefreshSnapshot({
            tableName,
            recordId: record.id,
            record,
            payout
          }).catch((err) =>
            console.error(`Could not post queued snapshot ${record.id}:`, err.message)
          );

          continue;
        }

        const expiresAt = Date.parse(record.get('Snapshot Expires At'));

        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
          await closeSnapshot(tableName, record.id, 'Expired');
          console.log(`📸 Snapshot expired for ${record.id} (${tableName})`);
        }
      }
    } catch (err) {
      console.error(`Snapshot sweep failed on ${tableName}:`, err.message);
    }
  }
}

// Every two minutes: often enough that an hour-long deal closes on time, and
// light enough that it is two Airtable reads.
setInterval(() => {
  sweepSnapshots().catch((err) => console.error('Snapshot sweep crashed:', err.message));
}, 2 * 60 * 1000);

app.post('/snapshot-deal/create', async (req, res) => {
  try {
    const { recordId, source, price } = req.body || {};

    if (!recordId) return res.status(400).send('Missing recordId');

    const payout = Number(price);

    if (!Number.isFinite(payout) || payout <= 0) {
      return res.status(400).send('Missing or invalid price');
    }

    const tableName = snapshotTableFor(source);
    const record = await base(tableName).find(recordId).catch(() => null);

    if (!record) return res.status(404).send(`Record ${recordId} not found in ${tableName}`);

    const alreadyPosted = String(record.get('Snapshot Message ID') || '');

    /*
      Nothing goes out in the quiet window unless it is already up. A price
      that moves at three in the morning still updates the record, so the
      sweep posts the right number in the morning - it just does not wake a
      channel nobody is reading.
    */
    if (!alreadyPosted && isSnapshotQuietHour()) {
      await base(tableName).update(recordId, {
        'Snapshot Price': payout,
        'Snapshot Status': 'Queued'
      });

      console.log(`📸 Snapshot queued for ${recordId} (${tableName}) € ${payout} - quiet hours.`);

      return res.json({ ok: true, queued: true });
    }

    const result = await postOrRefreshSnapshot({ tableName, recordId, record, payout });

    res.json({
      ok: true,
      refreshed: result.refreshed,
      channel_id: result.channelId,
      message_id: result.messageId,
      expires_at: result.expiresAt.toISOString()
    });
  } catch (err) {
    console.error('❌ snapshot-deal/create failed:', err);
    res.status(500).send(err.message);
  }
});

/*
 * Take a snapshot off the table: claimed, expired or cancelled.
 *
 * The embed stays where it is - a channel full of vanished messages tells a
 * seller nothing - but the button goes and the reason is written on it, so
 * anyone scrolling back can see what happened rather than clicking a button
 * that will only refuse them.
 */
app.post('/snapshot-deal/close', async (req, res) => {
  try {
    const { recordId, source, status } = req.body || {};

    if (!recordId) return res.status(400).send('Missing recordId');

    const reason = ['Claimed', 'Expired', 'Cancelled'].includes(status) ? status : 'Expired';
    const tableName = snapshotTableFor(source);

    // Same function the sweep uses, so a snapshot closed by hand and one
    // closed by the clock leave the channel looking identical.
    const closed = await closeSnapshot(tableName, recordId, reason);

    if (!closed) return res.status(404).send(`Record ${recordId} not found in ${tableName}`);

    console.log(`📸 Snapshot ${reason.toLowerCase()} for ${recordId} (${tableName})`);

    res.json({ ok: true, status: reason });
  } catch (err) {
    console.error('❌ snapshot-deal/close failed:', err);
    res.status(500).send(err.message);
  }
});

app.post('/quick-deal/create', async (req, res) => {
  try {
    const { recordId, orderNumber, productName, sku, size, brand, currentPayout, maxPayout, timeToMaxPayout, imageUrl } = req.body || {};
    const targetChannelId = pickQuickDealsChannelId(brand);
    console.log(`📌 Quick Deal create: brand="${brand || ''}" -> channelId=${targetChannelId}`);
    if (!targetChannelId) return res.status(400).send('Missing QUICK_DEALS_DEFAULT_CHANNEL_ID (or QUICK_DEALS_CHANNEL_ID)');
    if (!GUILD_ID) return res.status(400).send('Missing GUILD_ID env');
    if (!recordId) return res.status(400).send('Missing recordId');
    
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(targetChannelId);
    
    if (!channel || !channel.isTextBased()) {
      return res
        .status(404)
        .send(`Quick Deals target channel not found or not text-based (brand=${brand || '-'}, channelId=${targetChannelId})`);
    }
    const embed = new EmbedBuilder()
      .setTitle('⚡ Quick Deal')
      .setDescription(`**${productName || '-'}**\n${sku || '-'}\n${size || '-'}\n${brand || '-'}`)
      .setColor(0xffed00)
      .addFields(
        { name: 'Current Payout', value: currentPayout != null ? String(currentPayout) : '-', inline: true },
        { name: 'Max Payout', value: maxPayout != null ? String(maxPayout) : '-', inline: true },
        {
          name: 'Time to Max Payout',
          value: timeToMaxPayout != null && timeToMaxPayout !== '' ? String(timeToMaxPayout) : '-',
          inline: false
        }
      );
    if (imageUrl) embed.setImage(imageUrl);
    const claimButton = new ButtonBuilder().setCustomId(`quick_claim_${recordId}`).setLabel('Claim Deal').setStyle(ButtonStyle.Success);
    const seeAllButton = new ButtonBuilder().setLabel('See All Quick Deals').setStyle(ButtonStyle.Link).setURL(QUICK_DEALS_AIRTABLE_URL);
    const row = new ActionRowBuilder().addComponents(claimButton, seeAllButton);
    const msg = await channel.send({ embeds: [embed], components: [row] });
    const messageUrl = `https://discord.com/channels/${GUILD_ID}/${targetChannelId}/${msg.id}`;
    try {
      await base(ORDER_TABLE_NAME).update(recordId, {
        'Claim Message ID': msg.id,
        'Claim Message URL': messageUrl
      });
    } catch (e) {
      console.warn('⚠️ Could not update Unfulfilled Orders Log with Claim Message fields:', e.message);
    }
    return res.status(200).json({
      ok: true,
      channelId: targetChannelId,
      messageId: msg.id,
      messageUrl
    });
  } catch (err) {
    console.error('❌ Error creating Quick Deal embed:', err);
    return res.status(500).send('Internal Server Error');
  }
});
/**
 * POST /quick-deal/create-partners
 *
 * Mirror Quick Deal in partner servers via WEBHOOK URLs stored in Airtable "Partnerships"
 *
 * Stores partner messages in field:
 *  "Partner Quick Deals Message IDs" as: "partnerRecordId:messageId,partnerRecordId2:messageId2,..."
 */
app.post('/quick-deal/create-partners', async (req, res) => {
  try {
    const { recordId, productName, sku, size, brand, imageUrl } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'Missing recordId' });
    const partners = await getActiveQuickDealPartners();
    if (!partners.length) return res.json({ ok: true, message: 'No active Quick Deal partners found' });
    for (const partner of partners) {
      const inviteUrl = partner.inviteUrl || PARTNER_INVITE_URL;
      const embed = {
        title: '🔥 NEW WTB 🔥',
        color: 0xffed00,
        thumbnail: {
          url: 'https://i.imgur.com/JOFvdG2.png'
        },
        description:
          `**${productName || '-'}**\n` +
          `SKU: ${sku || '-'}\n` +
          `Size: ${size || '-'}\n` +
          `Brand: ${brand || '-'}\n\n` +
          `**Sell Now:** [click here](${inviteUrl})`,
        ...(imageUrl ? { image: { url: imageUrl } } : {}),
        footer: {
          text: '© 2026 Kickz Caviar — All rights reserved'
        }
      };
      const webhookUrl = String(partner.webhookUrl || '').split('?')[0];
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      }).catch(() => null);
      if (!resp || !resp.ok) {
        console.warn(`⚠️ Quick Deal webhook failed for partner ${partner.name} (${partner.id})`);
        continue;
      }
      await base(PARTNERS_TABLE_NAME)
        .update(partner.id, { [PARTNER_FIELD_LAST_QD_POST_AT]: new Date().toISOString() })
        .catch(() => null);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error in /quick-deal/create-partners:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});
/**
 * POST /quick-deal/update-embed
 *
 * Updates main Quick Deal + all partner Quick Deal messages
 *
 * NOTE: Partner updates are now done via WEBHOOK message edit endpoint:
 *   PATCH {webhookUrl}/messages/{messageId}
 */
app.post('/quick-deal/update-embed', async (req, res) => {
  try {
    let { channelId, messageId, currentPayout, maxPayout, recordId, timeToMaxPayout } = req.body || {};
    // ✅ Resolve correct channelId + messageId from Airtable (because listing is now posted in brand channels)
    let finalTimeToMax = timeToMaxPayout;
    if (recordId) {
      try {
        const rec = await base(ORDER_TABLE_NAME).find(recordId);
        // If Make didn't pass messageId, use Airtable stored one
        if (!messageId) {
          messageId = rec.get('Claim Message ID') || messageId;
        }
        // If Make didn't pass channelId, extract from Claim Message URL
        if (!channelId) {
          const claimUrl = rec.get('Claim Message URL');
          channelId = extractChannelIdFromDiscordUrl(claimUrl) || channelId;
        }
        // If Time-to-max not provided, pull from Airtable
        if (!finalTimeToMax) {
          finalTimeToMax = rec.get('Payout Countdown') || finalTimeToMax;
        }
      } catch (e) {
        console.warn('⚠️ Could not resolve channel/message from Airtable:', e.message);
      }
    }
    const targetChannelId = channelId || QUICK_DEALS_CHANNEL_ID;
    if (!targetChannelId || !messageId) {
      return res.status(400).send('Missing channelId/messageId (and could not resolve via recordId)');
    }
    // ----- Update main Quick Deal embed in your server -----
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).send('Channel not found or not text-based');
    }
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg || !msg.embeds || msg.embeds.length === 0) {
      return res.status(404).send('Message or embed not found');
    }
    const oldEmbed = msg.embeds[0];
    const newEmbed = EmbedBuilder.from(oldEmbed);
    const fields = [...(oldEmbed.fields || [])];
    const setField = (name, value, inline = true) => {
      const idx = fields.findIndex((f) => f.name === name);
      const val = value != null ? String(value) : '';
      if (idx >= 0) fields[idx] = { ...fields[idx], value: val };
      else fields.push({ name, value: val, inline });
    };
    if (currentPayout != null) setField('Current Payout', currentPayout, true);
    if (maxPayout != null) setField('Max Payout', maxPayout, true);
    if (finalTimeToMax != null && finalTimeToMax !== '') setField('Time to Max Payout', finalTimeToMax, false);
    else setField('Time to Max Payout', '-', false);
    newEmbed.setFields(fields);
    // ✅ Update ONLY main Quick Deal embed
    await msg.edit({ embeds: [newEmbed] });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Error updating Quick Deal embed:', err);
    return res.status(500).send('Internal Server Error');
  }
});
/**
 * POST /quick-deal/disable
 *
 * Disables Claim button on main Quick Deal (your server).
 * Partner messages stay as links to your server.
 */
app.post('/quick-deal/disable', async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) return res.status(400).send('Missing recordId');
    if (!QUICK_DEALS_DEFAULT_CHANNEL_ID && !QUICK_DEALS_CHANNEL_ID)
      return res.status(400).send('Missing QUICK_DEALS_DEFAULT_CHANNEL_ID (or QUICK_DEALS_CHANNEL_ID)');
    const orderRecord = await base(ORDER_TABLE_NAME).find(recordId);
    const claimMessageId = orderRecord.get('Claim Message ID');
    const claimMessageUrl = orderRecord.get('Claim Message URL');
    const listingChannelId =
      extractChannelIdFromDiscordUrl(claimMessageUrl) || QUICK_DEALS_DEFAULT_CHANNEL_ID || QUICK_DEALS_CHANNEL_ID;
    if (!claimMessageId) {
      return res.status(404).send('No Claim Message ID stored on this Unfulfilled Orders Log record');
    }
    const guild = await client.guilds.fetch(GUILD_ID);
    const dealsChannel = await guild.channels.fetch(listingChannelId);
    if (!dealsChannel || !dealsChannel.isTextBased()) return res.status(404).send('Quick Deals channel not found or not text-based');
    const listingMsg = await dealsChannel.messages.fetch(claimMessageId).catch(() => null);
    if (!listingMsg) return res.status(404).send('Listing message not found');
    const disabledClaim = new ButtonBuilder()
      .setCustomId(`quick_claim_${recordId}`)
      .setLabel('Claim Deal')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    const seeAllButton = new ButtonBuilder().setLabel('See All Quick Deals').setStyle(ButtonStyle.Link).setURL(QUICK_DEALS_AIRTABLE_URL);
    const disabledRow = new ActionRowBuilder().addComponents(disabledClaim, seeAllButton);
    await listingMsg.edit({ components: [disabledRow] });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Error disabling Quick Deal button:', err);
    return res.status(500).send('Internal Server Error');
  }
});
app.post('/quick-deal/claim-from-portal', async (req, res) => {
  try {
    const {
      recordId,
      sellerRecordId,
      sellerId,
      sellerDiscordId,
      vatType
    } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'Missing recordId' });
    if (!sellerRecordId) return res.status(400).json({ error: 'Missing sellerRecordId' });
    if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });
    if (!sellerDiscordId) return res.status(400).json({ error: 'Missing sellerDiscordId' });
    if (!['Margin', 'VAT21', 'VAT0'].includes(vatType)) {
      return res.status(400).json({ error: 'Invalid vatType' });
    }
    const orderRecordId = recordId;
    const orderRecord = await base(ORDER_TABLE_NAME).find(orderRecordId);
    const currentStatus = String(orderRecord.get('Fulfillment Status') || '').trim();
    if (currentStatus !== 'Outsource') {
      return res.status(409).json({
        error: `Deal is not claimable. Current status: ${currentStatus || 'Unknown'}`
      });
    }
    const sellerRecord = await base('Sellers Database').find(sellerRecordId);

    // Block based on the seller's own registration profile (VAT ID +
    // Country): private seller (no VAT ID) → Margin only; Dutch company →
    // no VAT0; non-Dutch company → no VAT21.
    const sellerVatEligibilityError = validateSellerVatEligibility(
      sellerRecord.get('VAT ID'),
      sellerRecord.get('Country'),
      vatType
    );
    if (sellerVatEligibilityError) {
      return res.status(400).json({ error: sellerVatEligibilityError });
    }

    const orderId = String(orderRecord.get('Order ID') || '').trim();
    const shopifyOrderNumber = String(orderRecord.get('Shopify Order Number') || '').trim();
    const size = orderRecord.get('Size') || '';
    const brand = orderRecord.get('Brand') || '';
    const productName = orderRecord.get('Product Name') ?? orderRecord.get('Shopify Product Name') ?? '';
    const sku = asText(orderRecord.get('SKU')).trim();
    const skuSoft = asText(orderRecord.get('SKU (Soft)')).trim();
    const finalSku = sku || skuSoft;
    const payoutMargin = Number(orderRecord.get('Outsource Buying Price') || 0);
    const payoutVat0 = Number(orderRecord.get('Outsource Buying Price (VAT 0%)') || 0);
    const payout = vatType === 'VAT0' ? payoutVat0 : payoutMargin;
    const pictureField = orderRecord.get('Picture');
    const imageUrl = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;
    if (!orderId || !productName || !finalSku || !size || !brand || !Number.isFinite(payout) || payout <= 0) {
      return res.status(400).json({
        error: 'Missing or invalid order fields for this Quick Deal.'
      });
    }
    const guild = await client.guilds.fetch(GUILD_ID);
    const pickedCategory = await pickCategoryWithSpace(guild, DEAL_CATEGORY_IDS);
    if (!pickedCategory) {
      return res.status(400).json({
        error: 'All deal categories are full. Please create a new category.'
      });
    }
    const rawChannelName = shopifyOrderNumber ? `${orderId}-${shopifyOrderNumber}` : orderId;
    const finalChannelName = toChannelSlug(rawChannelName).slice(0, 100);
    const cleanSellerDiscordId = String(sellerDiscordId).replace(/\D/g, '');
    console.log('sellerDiscordId raw:', sellerDiscordId);
    console.log('sellerDiscordId clean:', cleanSellerDiscordId);
    
    const sellerMember = await guild.members.fetch(cleanSellerDiscordId).catch(() => null);
    
    if (!sellerMember) {
      return res.status(400).json({
        error: 'Seller Discord ID is not a valid member in this Discord server',
        sellerDiscordId,
        cleanSellerDiscordId
      });
    }
    const channel = await guild.channels.create({
      name: finalChannelName,
      type: ChannelType.GuildText,
      parent: pickedCategory.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel]
        },
        {
          id: sellerMember.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.AttachFiles
          ]
        }
      ]
    });
    const embed = new EmbedBuilder()
      .setTitle('💸 Quick Deal Claimed')
      .setDescription(
        `**Order:** ${orderId}\n` +
        `**Product:** ${productName}\n` +
        `**SKU:** ${finalSku}\n` +
        `**Size:** ${size}\n` +
        `**Brand:** ${brand}\n` +
        `**Payout:** €${payout.toFixed(2)}\n` +
        `**VAT Type:** ${vatType}\n` +
        `**Seller (claimed with):** ${sellerId}`
      )
      .setColor(0xffed00);
    if (imageUrl) embed.setImage(imageUrl);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start_claim').setLabel('Process Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cancel_deal').setLabel('Cancel Deal').setStyle(ButtonStyle.Danger)
    );
    const dealMsg = await channel.send({
      embeds: [embed],
      components: [row]
    });
    sellerMap.set(channel.id, {
      orderRecordId,
      dealEmbedId: dealMsg.id,
      sellerRecordId: sellerRecord.id,
      sellerDiscordId,
      sellerId,
      vatType,
      payoutChosen: payout,
      isQuickDeal: true,
      quickDealRecordId: recordId,
      confirmed: false
    });
    await base(ORDER_TABLE_NAME).update(orderRecordId, {
      'Fulfillment Status': 'Claim Processing',
      'Claimed Channel ID': channel.id,
      'Claimed Message ID': dealMsg.id,
      'Claimed Seller ID': [sellerRecord.id],
      'Claimed Seller Discord ID': sellerDiscordId,
      'Claimed Seller Confirmed?': false,
      'Claimed Seller VAT Type': vatType,
      'Claimed Seller Payout': payout
    });
    try {
      const claimMessageId = orderRecord.get('Claim Message ID');
      const claimMessageUrl = orderRecord.get('Claim Message URL');
      const listingChannelId =
        extractChannelIdFromDiscordUrl(claimMessageUrl) || QUICK_DEALS_DEFAULT_CHANNEL_ID || QUICK_DEALS_CHANNEL_ID;
      if (claimMessageId && listingChannelId) {
        const dealsChannel = await client.channels.fetch(listingChannelId);
        if (dealsChannel && dealsChannel.isTextBased()) {
          const listingMsg = await dealsChannel.messages.fetch(claimMessageId).catch(() => null);
          if (listingMsg) {
            const disabledClaim = new ButtonBuilder()
              .setCustomId(`quick_claim_${recordId}`)
              .setLabel('Claim Deal')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true);
            const seeAllButton = new ButtonBuilder()
              .setLabel('See All Quick Deals')
              .setStyle(ButtonStyle.Link)
              .setURL(QUICK_DEALS_AIRTABLE_URL);
            const disabledRow = new ActionRowBuilder().addComponents(disabledClaim, seeAllButton);
            await listingMsg.edit({
              components: [disabledRow]
            });
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ Could not disable Discord Claim Deal button:', e.message);
    }
    return res.json({
      ok: true,
      channelId: channel.id,
      channelUrl: `https://discord.com/channels/${GUILD_ID}/${channel.id}`,
      messageId: dealMsg.id
    });
  } catch (err) {
    console.error('❌ Error claiming Quick Deal from portal:', err);
    return res.status(500).json({
      error: 'Something went wrong while claiming this Quick Deal.',
      details: err.message
    });
  }
});
/* =================================================
   DISCORD INTERACTIONS – QUICK DEAL CLAIM & FLOW
   ================================================= */
client.on(Events.InteractionCreate, async (interaction) => {
  if ((interaction.isButton() && interaction.customId.startsWith('partner_')) || (interaction.isModalSubmit() && interaction.customId.startsWith('partner_'))) {
    return;
  }
  /* ---------- PROFIEL CLAIMEN ----------
   *
   * Voor sellers met een Seller ID uit de tijd dat we het Discord ID nog niet
   * vastlegden. Eenmalig: Seller ID + e-mail, dan een code naar dat adres.
   * Discord staat geen modal toe als antwoord op een modal, vandaar de
   * afwisseling knop -> modal -> knop -> modal.
   */
  if (interaction.isButton() && interaction.customId === 'claim_start') {
    try {
      await interaction.showModal(buildClaimProfileModal());
    } catch (err) {
      console.error('claim_start showModal failed:', err);
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'claim_profile_modal') {
    await interaction.deferReply({ flags: 64 });

    const sellerIdInput = interaction.fields.getTextInputValue('claim_seller_id').trim();
    const emailInput = interaction.fields.getTextInputValue('claim_email').trim();

    let result;

    try {
      result = await portalPost('/api/internal/claim/start', {
        discord_id: interaction.user.id,
        seller_id: sellerIdInput,
        email: emailInput
      });
    } catch (err) {
      console.error('claim/start failed:', err);
      return interaction.editReply({
        content: `⚠️ Something went wrong. Please try again, or open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
      });
    }

    if (!result?.ok) {
      return interaction.editReply({
        content: `❌ ${result?.error || 'We could not match that Seller ID and email.'}\n\nNeed help? Open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
      });
    }

    return interaction.editReply({
      content: [
        `📧 We sent a 6-digit code to **${emailInput}**.`,
        '',
        'Enter it below to finish linking. The code expires in 15 minutes.'
      ].join('\n'),
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'Enter my code', custom_id: 'claim_code' }] }
      ]
    });
  }

  if (interaction.isButton() && interaction.customId === 'claim_code') {
    const modal = new ModalBuilder().setCustomId('claim_code_modal').setTitle('Enter your code');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('claim_code_value')
          .setLabel('6-digit code from your email')
          .setPlaceholder('123456')
          .setStyle(TextInputStyle.Short)
          .setMinLength(6)
          .setMaxLength(6)
          .setRequired(true)
      )
    );

    try {
      await interaction.showModal(modal);
    } catch (err) {
      console.error('claim_code showModal failed:', err);
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'claim_code_modal') {
    await interaction.deferReply({ flags: 64 });

    let result;

    try {
      result = await portalPost('/api/internal/claim/confirm', {
        discord_id: interaction.user.id,
        discord_tag: interaction.user.username,
        code: interaction.fields.getTextInputValue('claim_code_value').trim()
      });
    } catch (err) {
      console.error('claim/confirm failed:', err);
      return interaction.editReply({
        content: `⚠️ Something went wrong. Please try again, or open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
      });
    }

    if (!result?.ok) {
      return interaction.editReply({
        content: `❌ ${result?.error || 'That code is not correct.'}`,
        components: [
          { type: 1, components: [{ type: 2, style: 2, label: 'Try again', custom_id: 'claim_code' }] }
        ]
      });
    }

    // Gekoppeld. Stond hij midden in een Quick Deal, dan krijgt hij de knop om
    // daar direct verder te gaan in plaats van opnieuw te moeten zoeken.
    // De cache zei net nog "niet gevonden"; dat klopt niet meer.
    forgetSellerLookup(interaction.user.id);

    const pending = pendingQuickClaims.get(interaction.user.id);
    pendingQuickClaims.delete(interaction.user.id);

    const lines = [
      `✅ Linked. Your Seller ID **${result.seller_id}** is now connected to this Discord account.`,
      '',
      'You never have to enter it again.'
    ];

    const components = [];

    if (pending?.recordId) {
      lines.push('', 'Click below to finish the Quick Deal you started.');
      components.push({
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Continue my claim', custom_id: `quick_claim_${pending.recordId}` }
        ]
      });
    }

    return interaction.editReply({ content: lines.join('\n'), components });
  }

  /* ---------- QUICK DEAL: Claim button → modal ---------- */
  /* ---------- SNAPSHOT PROCESS DEAL → hand it to us ---------- */
  if (interaction.isButton() && interaction.customId.startsWith('snapshot_process:')) {
    const [, source, recordId] = interaction.customId.split(':');
    const tableName = snapshotTableFor(source);

    try {
      await interaction.deferUpdate();
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: 'That button expired. Please let us know and we will re-open the deal.'
        });
        return;
      }

      throw err;
    }

    try {
      const data = sellerMap.get(interaction.channel.id);

      /*
        Only the seller who claimed it may process it.

        The channel is private to him, but a stray permission or a mistaken
        invite should not be enough to hand somebody else's deal away.
      */
      if (data?.sellerDiscordId && data.sellerDiscordId !== interaction.user.id) {
        await interaction.followUp({
          content: 'Only the seller who claimed this deal can process it.',
          flags: 64
        }).catch(() => null);

        return;
      }

      await base(tableName)
        .update(recordId, { 'Claimed Seller Confirmed?': true })
        .catch((err) =>
          console.error(`Could not mark ${recordId} as confirmed by the seller:`, err.message)
        );

      if (data) sellerMap.set(interaction.channel.id, { ...data, confirmed: true });

      // The seller has done his part, so his buttons go. Cancel stays with
      // us on the message below, where it belongs.
      await interaction.message.edit({
        embeds: interaction.message.embeds,
        components: []
      }).catch((err) => console.error('Could not clear the snapshot deal buttons:', err.message));

      /*
        No photo wall here, unlike a Quick Deal.

        A snapshot is priced and agreed before it is claimed, and its whole
        point is speed - the buyer may walk if this takes hours. So the seller
        says he can supply it and the deal is ours to confirm.
      */
      await interaction.channel.send({
        content: 'The seller confirmed he can supply this pair. Ready for us to confirm.',
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('confirm_deal')
              .setLabel('Confirm Deal')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('cancel_deal')
              .setLabel('Cancel Deal')
              .setStyle(ButtonStyle.Danger)
          )
        ]
      });

      console.log(`Snapshot processed by the seller for ${recordId} (${tableName}).`);
    } catch (err) {
      console.error('snapshot_process failed:', err);

      await interaction.channel
        .send({ content: 'Something went wrong. Please let us know.' })
        .catch(() => null);
    }

    return;
  }

  /* ---------- SNAPSHOT CLAIM → VAT modal ---------- */
  if (interaction.isButton() && interaction.customId.startsWith('snapshot_claim:')) {
    const [, source, recordId] = interaction.customId.split(':');

    // Same courtesy as a Quick Deal: someone whose Seller ID is not linked
    // yet is told how to fix it instead of meeting a silent failure.
    const sellerCheck = await lookupSellerCached(interaction.user.id);

    if (sellerCheck && !sellerCheck.found) {
      await interaction.reply({
        embeds: [NOT_LINKED_EMBED],
        components: notLinkedComponents(),
        flags: 64
      }).catch(() => null);

      await dmNotLinked(interaction.user);
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`snapshot_claim_modal:${source}:${recordId}`)
      .setTitle('Claim Snapshot Deal');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('vat_type')
          .setLabel('VAT Type (Margin / VAT21 / VAT0)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('Margin, VAT21 or VAT0')
      )
    );

    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: 'This snapshot button expired. Please use a fresh one if available.'
        });
        return;
      }

      console.error('snapshot_claim showModal failed:', err);
    }

    return;
  }

  /* ---------- SNAPSHOT CLAIM MODAL → deal channel ---------- */
  if (interaction.isModalSubmit() && interaction.customId.startsWith('snapshot_claim_modal:')) {
    await interaction.deferReply({ flags: 64 });

    const [, source, recordId] = interaction.customId.split(':');
    const tableName = snapshotTableFor(source);

    try {
      const rawVat = String(interaction.fields.getTextInputValue('vat_type') || '')
        .trim()
        .toUpperCase();

      const vatType =
        rawVat === 'VAT0' ? 'VAT0' :
        rawVat === 'VAT21' ? 'VAT21' :
        rawVat === 'MARGIN' ? 'Margin' : '';

      if (!vatType) return interaction.editReply('Enter Margin, VAT21 or VAT0.');

      const sellerLookup = await portalPost('/api/internal/seller-by-discord', {
        discord_id: interaction.user.id
      }).catch(() => null);

      if (!sellerLookup || !sellerLookup.seller_record_id) {
        await dmNotLinked(interaction.user);
        return interaction.editReply('Your Seller ID is not linked yet. Check your DMs.');
      }

      const record = await base(tableName).find(recordId).catch(() => null);

      if (!record) return interaction.editReply('This deal no longer exists.');

      /*
        The race is settled on the record, not on the button.

        Two sellers can press Claim inside the same second and Discord will
        deliver both. Whoever finds the snapshot no longer Active was second,
        and he is told so plainly rather than walked through a deal he cannot
        have.
      */
      if (String(record.get('Snapshot Status') || '') !== 'Active') {
        return interaction.editReply('This snapshot is no longer available.');
      }

      const snapshotPrice = Number(record.get('Snapshot Price') || 0);

      if (!(snapshotPrice > 0)) {
        return interaction.editReply('This snapshot has no price on it. Please let us know.');
      }

      // The stored price is VAT-inclusive. A VAT0 seller invoices without
      // VAT, so his side of the same deal is that figure over 1.21.
      // The same number a consignor on that VAT type would have been offered,
      // grid and all. Anything else and the two routes disagree on one deal.
      const payout = snapshotPayoutFor(snapshotPrice, vatType);

      const orderId = String(
        record.get('Order ID') || record.get('Member WTB ID') || recordId
      );

      const productName = String(record.get('Product Name') || '');
      const sku = String(record.get('SKU') || record.get('SKU (Soft)') || '');
      const size = String(record.get('Size') || '');
      const brand = String(record.get('Brand') || '');

      const guild = await client.guilds.fetch(GUILD_ID);
      const pickedCategory = await pickCategoryWithSpace(guild, snapshotDealCategoryIds());

      if (!pickedCategory) {
        return interaction.editReply('No deal category with room left. Please let us know.');
      }

      const channel = await guild.channels.create({
        name: toChannelSlug(orderId).slice(0, 100),
        type: ChannelType.GuildText,
        parent: pickedCategory.id,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          {
            id: interaction.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.AttachFiles
            ]
          }
        ]
      });

      const dealEmbed = new EmbedBuilder()
        .setTitle('Snapshot Deal Claimed')
        .setDescription(
          `**Order:** ${orderId}\n` +
            `**Product:** ${productName}\n` +
            `**SKU:** ${sku}\n` +
            `**Size:** ${size}\n` +
            `**Brand:** ${brand}\n` +
            `**Payout:** ${payout.toFixed(2)}\n` +
            `**VAT Type:** ${vatType}\n\n` +
            'Press **Process Deal** to confirm you can supply this pair.'
        )
        .setColor(0xffed00);

      const dealMsg = await channel.send({
        content: `<@${interaction.user.id}>`,
        embeds: [dealEmbed],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`snapshot_process:${source}:${recordId}`)
              .setLabel('Process Deal')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('cancel_deal')
              .setLabel('Cancel Deal')
              .setStyle(ButtonStyle.Danger)
          )
        ]
      });

      await base(tableName).update(recordId, {
        'Fulfillment Status': 'Claim Processing',
        'Claimed Channel ID': channel.id,
        'Claimed Message ID': dealMsg.id,
        'Claimed Seller ID': [sellerLookup.seller_record_id],
        'Claimed Seller Discord ID': interaction.user.id,
        'Claimed Seller Confirmed?': false,
        'Claimed Seller VAT Type': vatType,
        'Claimed Seller Payout': payout
      });

      /*
        Off the market at once.

        The sweep would catch this within a couple of minutes, and a couple
        of minutes is long enough for somebody else to press Claim and be
        refused for it.
      */
      await closeSnapshot(tableName, recordId, 'Claimed');

      sellerMap.set(channel.id, {
        orderRecordId: recordId,
        sellerRecordId: sellerLookup.seller_record_id,
        sellerDiscordId: interaction.user.id,
        sellerId: sellerLookup.seller_id,
        vatType,
        payoutChosen: payout,
        isSnapshotDeal: true,
        snapshotSource: source,
        confirmed: false
      });

      console.log(
        `Snapshot claimed by ${sellerLookup.seller_id} for ${orderId} ` +
          `(${tableName}) ${payout} ${vatType} -> ${channel.id}`
      );

      return interaction.editReply(`Claimed. Continue in <#${channel.id}>.`);
    } catch (err) {
      console.error('snapshot_claim_modal failed:', err);
      return interaction.editReply('Something went wrong claiming this deal.');
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('quick_claim_')) {
    const recordId = interaction.customId.replace('quick_claim_', '').trim();

    // Nog geen gekoppeld profiel? Dan meteen de claim-modal. Dit moet hier en
    // niet bij het versturen: Discord staat geen modal toe als antwoord op een
    // modal, dus daar rest alleen een ephemeral bericht — en dat verschijnt
    // onderaan het kanaal waar het over het hoofd gezien wordt.
    const sellerCheck = await lookupSellerCached(interaction.user.id);

    if (sellerCheck && !sellerCheck.found) {
      pendingQuickClaims.set(interaction.user.id, { recordId, at: Date.now() });

      await interaction.reply({
        embeds: [NOT_LINKED_EMBED],
        components: notLinkedComponents(),
        flags: 64
      }).catch(() => null);

      await dmNotLinked(interaction.user);
      return;
    }

    const modal = new ModalBuilder().setCustomId(`quick_claim_modal_${recordId}`).setTitle('Claim Quick Deal');
    const vatInput = new TextInputBuilder()
      .setCustomId('vat_type')
      .setLabel('VAT Type (Margin / VAT21 / VAT0)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('Margin, VAT21 or VAT0');
    modal.addComponents(new ActionRowBuilder().addComponents(vatInput));
    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ That Quick Deal button expired. Please use a fresh one if available.'
        });
        return;
      }
      console.error('quick_claim showModal failed:', err);
      try {
        await interaction.reply({ content: '❌ Could not open the Quick Deal claim form. Please try again.', flags: 64 });
      } catch (_) {}
    }
    return;
  }
  /* ---------- QUICK DEAL: modal submit (Seller ID + VAT) ---------- */
  if (interaction.isModalSubmit() && interaction.customId.startsWith('quick_claim_modal_')) {
    await interaction.deferReply({ flags: 64 });
  
    const recordId = interaction.customId.replace('quick_claim_modal_', '').trim();
    const vatRawInput = interaction.fields.getTextInputValue('vat_type');
    const vatType = normalizeQuickVatType(vatRawInput);

    if (!vatType) {
      return interaction.editReply({ content: '❌ Invalid VAT Type. Please use **Margin**, **VAT21** or **VAT0**.' });
    }

    // Wie de deal claimt volgt uit het Discord ID van degene die klikt. Vroeger
    // typte hij zelf een Seller ID in en controleerde niemand of dat het zijne
    // was, dus kon iedereen een deal claimen namens een ander.
    let sellerLookup = null;

    try {
      sellerLookup = await portalPost('/api/internal/seller-by-discord', {
        discord_id: interaction.user.id
      });
    } catch (lookupErr) {
      console.error('seller-by-discord failed:', lookupErr);
      return interaction.editReply({
        content: '⚠️ Could not reach the seller database. Please try again in a moment.'
      });
    }

    if (!sellerLookup?.found) {
      pendingQuickClaims.set(interaction.user.id, { recordId, vatRawInput, at: Date.now() });

      await dmNotLinked(interaction.user);

      return interaction.editReply({
        embeds: [NOT_LINKED_EMBED],
        components: notLinkedComponents()
      });
    }

    const sellerId = sellerLookup.seller_id;

    try {
      const sellerRecord = await base('Sellers Database').find(sellerLookup.seller_record_id).catch(() => null);

      if (!sellerRecord) {
        return interaction.editReply({
          content: `❌ Your seller profile could not be loaded. Please open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
        });
      }

      // Block based on the seller's own registration profile (VAT ID +
      // Country): private seller (no VAT ID) → Margin only; Dutch company →
      // no VAT0; non-Dutch company → no VAT21.
      const sellerVatEligibilityError = validateSellerVatEligibility(
        sellerRecord.get('VAT ID'),
        sellerRecord.get('Country'),
        vatType
      );
      if (sellerVatEligibilityError) {
        return interaction.editReply({ content: `❌ ${sellerVatEligibilityError}` });
      }

      const orderRecordId = recordId;
      const orderRecord = await base(ORDER_TABLE_NAME).find(orderRecordId);
      const orderId = String(orderRecord.get('Order ID') || '').trim();
      const shopifyOrderNumber = String(orderRecord.get('Shopify Order Number') || '').trim(); // <-- change field name if your Airtable uses another label
      const size = orderRecord.get('Size') || '';
      const brand = orderRecord.get('Brand') || '';
      const productName = orderRecord.get('Product Name') ?? orderRecord.get('Shopify Product Name') ?? '';
      const sku = asText(orderRecord.get('SKU')).trim();
      const skuSoft = asText(orderRecord.get('SKU (Soft)')).trim();
      const finalSku = sku || skuSoft;
      const payoutMargin = Number(orderRecord.get('Outsource Buying Price') || 0);
      const payoutVat0 = Number(orderRecord.get('Outsource Buying Price (VAT 0%)') || 0);
      const payout = vatType === 'VAT0' ? payoutVat0 : payoutMargin;
      const pictureField = orderRecord.get('Picture');
      const imageUrl = Array.isArray(pictureField) && pictureField.length > 0 ? pictureField[0].url : null;
      if (!orderId || !productName || !finalSku || !size || !brand || !Number.isFinite(payout) || payout <= 0) {
        return interaction.editReply({ content: '❌ Missing or invalid order fields for this Quick Deal.' });
      }
      const guild = await client.guilds.fetch(GUILD_ID);
      // Pick a category that still has room (<50 channels)
      const pickedCategory = await pickCategoryWithSpace(guild, DEAL_CATEGORY_IDS);
      console.log(
        `📁 Deal category pick: ${pickedCategory ? `${pickedCategory.name} (${pickedCategory.id})` : 'NONE (all full)'}`
      );
      if (!pickedCategory) {
        return interaction.editReply({
          content: '❌ All deal categories are full (50 channels each). Please contact staff to create a new category.'
        });
      }
      // Build channel name: Order ID + Shopify Order Number
      const rawChannelName = shopifyOrderNumber ? `${orderId}-${shopifyOrderNumber}` : orderId;
      const finalChannelName = toChannelSlug(rawChannelName).slice(0, 100);
      
      const channel = await guild.channels.create({
        name: finalChannelName,
        type: ChannelType.GuildText,
        parent: pickedCategory.id,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          {
            id: interaction.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.AttachFiles
            ]
          }
        ]
      });
      const embed = new EmbedBuilder()
        .setTitle('💸 Quick Deal Claimed')
        .setDescription(
          `**Order:** ${orderId}\n` +
            `**Product:** ${productName}\n` +
            `**SKU:** ${finalSku}\n` +
            `**Size:** ${size}\n` +
            `**Brand:** ${brand}\n` +
            `**Payout:** €${payout.toFixed(2)}\n` +
            `**VAT Type:** ${vatType}\n` +
            `**Seller (claimed with):** ${sellerId}`
        )
        .setColor(0xffed00);
      if (imageUrl) embed.setImage(imageUrl);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start_claim').setLabel('Process Claim').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cancel_deal').setLabel('Cancel Deal').setStyle(ButtonStyle.Danger)
      );
      const dealMsg = await channel.send({ embeds: [embed], components: [row] });
      sellerMap.set(channel.id, {
        orderRecordId,
        dealEmbedId: dealMsg.id,
        sellerRecordId: sellerRecord.id,
        sellerDiscordId: interaction.user.id,
        sellerId,
        vatType,
        payoutChosen: payout,
        isQuickDeal: true,
        quickDealRecordId: recordId,
        confirmed: false
      });
      await base(ORDER_TABLE_NAME).update(orderRecordId, {
        'Fulfillment Status': 'Claim Processing',
        'Claimed Channel ID': channel.id,
        'Claimed Message ID': dealMsg.id,
        'Claimed Seller ID': [sellerRecord.id],
        'Claimed Seller Discord ID': interaction.user.id,
        'Claimed Seller Confirmed?': false,
        'Claimed Seller VAT Type': vatType,
        'Claimed Seller Payout': payout
      });
      // disable Claim button on MAIN listing (partner messages are links)
      try {
        const claimMessageId = orderRecord.get('Claim Message ID');
        const claimMessageUrl = orderRecord.get('Claim Message URL');
      
        // Determine which channel the listing message is actually in
        const listingChannelId =
          extractChannelIdFromDiscordUrl(claimMessageUrl) || QUICK_DEALS_DEFAULT_CHANNEL_ID || QUICK_DEALS_CHANNEL_ID;
      
        if (claimMessageId && listingChannelId) {
          const dealsChannel = await client.channels.fetch(listingChannelId);
          if (dealsChannel && dealsChannel.isTextBased()) {
            const listingMsg = await dealsChannel.messages.fetch(claimMessageId).catch(() => null);
            if (listingMsg) {
              const disabledClaim = new ButtonBuilder()
                .setCustomId(`quick_claim_${recordId}`)
                .setLabel('Claim Deal')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true);
      
              const seeAllButton = new ButtonBuilder()
                .setLabel('See All Quick Deals')
                .setStyle(ButtonStyle.Link)
                .setURL(QUICK_DEALS_AIRTABLE_URL);
      
              const disabledRow = new ActionRowBuilder().addComponents(disabledClaim, seeAllButton);
      
              await listingMsg.edit({ components: [disabledRow] });
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ Could not disable Claim Deal button:', e.message);
      }
      await interaction.editReply({
        content: `✅ Quick Deal claimed! Your deal channel is <#${channel.id}>.\nPlease click **"Process Claim"** in that channel to verify your Seller ID and start the photo upload.`
      });
    } catch (err) {
      console.error('❌ Error processing Quick Deal claim:', err);
      return interaction.editReply({ content: '❌ Something went wrong while claiming this Quick Deal. Please try again.' });
    }
    return;
  }
  /* ---------- START CLAIM → “Is this you?” ---------- */
  if (interaction.isButton() && interaction.customId === 'start_claim') {
    const channelId = interaction.channel.id;
    let data = sellerMap.get(channelId);
    try {
      if (!data || !data.orderRecordId || !data.sellerRecordId) {
        const orderNumber = getOrderIdFromChannelName(interaction.channel.name);
        const recs = await findDealRecords(orderNumber);
        if (recs.length) {
          const rec = recs[0];
          data = {
            ...(data || {}),
            orderRecordId: rec.id,
            sellerRecordId: (rec.get('Claimed Seller ID') || [])[0],
            sellerDiscordId: rec.get('Claimed Seller Discord ID'),
            vatType: rec.get('Claimed Seller VAT Type'),
            confirmed: !!rec.get('Claimed Seller Confirmed?')
          };
          sellerMap.set(channelId, data);
        }
      }
      if (!data?.sellerRecordId) {
        return interaction.reply({ content: '❌ No claimed Seller found for this deal. Please cancel and reclaim the deal.', flags: 64 });
      }
      const sellerRecord = await base('Sellers Database').find(data.sellerRecordId);
      const sellerIdField = sellerRecord.get('Seller ID') || data.sellerId || 'Unknown ID';
      const discordUsername = sellerRecord.get('Discord') || 'Unknown';
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_seller').setLabel('✅ Yes, that is me').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('reject_seller').setLabel('❌ No, not me').setStyle(ButtonStyle.Danger)
      );
      await interaction.reply({
        content: `🔍 We found this Discord Username linked to Seller ID **${sellerIdField}**:\n**${discordUsername}**\n\nIs this you?`,
        components: [confirmRow]
      });
    } catch (err) {
      console.error('❌ Error starting claim verification:', err);
      try {
        await interaction.reply({ content: '❌ Something went wrong while verifying your Seller ID. Please try again or contact support.', flags: 64 });
      } catch (_) {}
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('request_label_quick_deal:')) {
    const orderRecordId = interaction.customId.replace('request_label_quick_deal:', '').trim();
  
    try {
      await interaction.deferUpdate();
  
      const existingRows = interaction.message.components || [];
  
      const newRows = existingRows.map((row) =>
        new ActionRowBuilder().addComponents(
          ...row.components.map((btn) => {
            if (btn.customId?.startsWith('request_label_quick_deal:')) {
              return ButtonBuilder.from(btn)
                .setDisabled(true)
                .setLabel('Label Requested')
                .setStyle(ButtonStyle.Secondary);
            }
            return btn;
          })
        )
      );
  
      await interaction.message.edit({
        components: newRows
      }).catch(() => null);
  
      if (!LOJIQ_WMS_BASE_URL) {
        throw new Error('LOJIQ_WMS_BASE_URL is missing');
      }
  
      const response = await fetch(`${LOJIQ_WMS_BASE_URL.replace(/\/$/, '')}/api/request-label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'quick_deal',
          record_id: orderRecordId
        })
      });
  
      const data = await response.json().catch(() => ({}));
  
      if (!response.ok) {
        throw new Error(data.details || data.error || 'Failed to request label');
      }
  
      await interaction.followUp({
        content: data.message || '✅ Label request received. We’ll process it shortly.',
        flags: 64
      });
    } catch (err) {
      console.error('❌ request_label_quick_deal failed:', err);
  
      await interaction.followUp({
        content: `❌ ${err.message || 'Failed to request label'}`,
        flags: 64
      }).catch(() => null);
    }
  
    return;
  }
  /* ---------- CONFIRM / REJECT SELLER ---------- */
  if (interaction.isButton() && ['confirm_seller', 'reject_seller'].includes(interaction.customId)) {
    const channelId = interaction.channel.id;
    let data = sellerMap.get(channelId) || {};
    try {
      await interaction.deferUpdate();
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({ content: '⚠️ Those buttons expired. Please click **"Process Claim"** again.' });
        return;
      }
      throw err;
    }
    if (interaction.customId === 'confirm_seller') {
      sellerMap.set(channelId, { ...data, confirmed: true });
      try {
        let orderRecordId = data.orderRecordId;
        if (!orderRecordId) {
          const orderNumber = getOrderIdFromChannelName(interaction.channel.name);
          const recs = await findDealRecords(orderNumber);
          if (recs.length) {
            orderRecordId = recs[0].id;
            sellerMap.set(channelId, { ...sellerMap.get(channelId), orderRecordId });
          }
        }
        if (orderRecordId) {
          await base(ORDER_TABLE_NAME).update(orderRecordId, { 'Claimed Seller Confirmed?': true });
        }
      } catch (e) {
        console.warn('Could not persist Claimed Seller Confirmed? to Airtable:', e);
      }
      try {
        await interaction.message.edit({
          content: '✅ Seller ID confirmed.\nPlease upload **6 different** pictures of the pair like shown below to prove it is in-hand and complete.',
          components: []
        });
        await interaction.channel.send({ files: ['https://i.imgur.com/JKaeeNz.png'] });
      } catch (e) {
        console.error('Failed to edit confirm_seller message:', e);
      }
      return;
    }
    if (interaction.customId === 'reject_seller') {
      try {
        await interaction.message.edit({
          content:
            '⚠️ Please check if the Seller ID was filled in correctly.\n\nIf it is wrong, cancel this deal and claim it again with the correct Seller ID.',
          components: []
        });
      } catch (e) {
        console.error('Failed to edit reject_seller message:', e);
      }
      return;
    }
  }
  /* ---------- CANCEL DEAL BUTTON ---------- */
  if (interaction.isButton() && interaction.customId === 'cancel_deal') {
    console.log(`🛑 Cancel Deal clicked in ${interaction.channel.name}`);
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err) {
      if (err.code === 10062) {
        console.warn(`⚠️ Expired Cancel Deal button clicked in ${interaction.channel.name}`);
        await interaction.channel.send({ content: '⚠️ This Cancel Deal button has expired. Please use a new one if available.' });
        return;
      } else {
        throw err;
      }
    }
    try {
      const channel = interaction.channel;
      const data = sellerMap.get(channel.id);
      let recordId = data?.orderRecordId;
      if (!recordId) {
        const orderNumber = getOrderIdFromChannelName(channel.name);
        const records = await findDealRecords(orderNumber);
        if (records.length > 0) recordId = records[0].id;
      }
      if (!recordId) return await interaction.editReply('❌ Record ID not found.');
      // re-enable Claim button on MAIN listing (partner messages remain links)
      try {
        if (data?.isQuickDeal) {
          const orderRecord = await base(ORDER_TABLE_NAME).find(recordId);
          const claimMessageId = orderRecord.get('Claim Message ID');
          const claimMessageUrl = orderRecord.get('Claim Message URL');
          
          const listingChannelId =
            extractChannelIdFromDiscordUrl(claimMessageUrl) || QUICK_DEALS_DEFAULT_CHANNEL_ID || QUICK_DEALS_CHANNEL_ID;
          
          if (claimMessageId && listingChannelId) {
            const dealsChannel = await client.channels.fetch(listingChannelId);
            if (dealsChannel && dealsChannel.isTextBased()) {
              const listingMsg = await dealsChannel.messages.fetch(claimMessageId).catch(() => null);
              if (listingMsg) {
                const enabledClaim = new ButtonBuilder()
                  .setCustomId(`quick_claim_${recordId}`)
                  .setLabel('Claim Deal')
                  .setStyle(ButtonStyle.Success)
                  .setDisabled(false);
          
                const seeAllButton = new ButtonBuilder()
                  .setLabel('See All Quick Deals')
                  .setStyle(ButtonStyle.Link)
                  .setURL(QUICK_DEALS_AIRTABLE_URL);
          
                const enabledRow = new ActionRowBuilder().addComponents(enabledClaim, seeAllButton);
          
                await listingMsg.edit({ components: [enabledRow] });
              }
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ Could not re-enable Claim Deal button:', e.message);
      }
      await base(ORDER_TABLE_NAME).update(recordId, {
        'Fulfillment Status': 'Outsource',
        'Outsource Start Time': new Date().toISOString(),
        'Claimed Channel ID': '',
        'Claimed Message ID': '',
        'Claimed Seller ID': [],
        'Claimed Seller Discord ID': '',
        'Claimed Seller Confirmed?': false,
        'Claimed Seller VAT Type': null,
        'Claimed Seller Payout': null
      });
      const orderNumber = getOrderIdFromChannelName(channel.name);
      const invRecords = await base('Inventory Units')
        .select({
          filterByFormula: `{Ticket Number} = "${orderNumber}"`,
          maxRecords: 1
        })
        .firstPage();
      if (invRecords.length > 0) {
        await base('Inventory Units').update(invRecords[0].id, {
          'Verification Status': 'Cancelled',
          'Selling Method': null,
          'Unfulfilled Orders Log': [],
          'Payment Status': null,
          'Availability Status': null
        });
      }
      const transcriptFileName = `transcript-${channel.name}.html`;
      const transcript = await createTranscript(channel, {
        limit: -1,
        returnBuffer: false,
        fileName: transcriptFileName
      });
      const transcriptsChannel = await client.channels.fetch(TRANSCRIPTS_CHANNEL_ID);
      if (transcriptsChannel?.isTextBased()) {
        await transcriptsChannel.send({
          content: `🗒️ Transcript for cancelled deal channel **${channel.name}**`,
          files: [transcript]
        });
      }
      await interaction.editReply('✅ Deal has been cancelled. Channel will be deleted shortly.');
      setTimeout(() => channel.delete().catch(console.error), 3000);
    } catch (err) {
      console.error('❌ Cancel Deal error:', err);
      await interaction.editReply('❌ Something went wrong while cancelling this deal.');
    }
    return;
  }
  /* ---------- CONFIRM DEAL BUTTON (ADMIN) ---------- */
  if (interaction.isButton() && interaction.customId === 'confirm_deal') {
    const memberRoles = interaction.member.roles.cache.map((role) => role.id);
    const isAdmin = ADMIN_ROLE_IDS.some((roleId) => roleId && memberRoles.includes(roleId));
    if (!isAdmin) return interaction.reply({ content: '❌ You are not authorized to confirm the deal.' });
    try {
      await interaction.deferReply();
    } catch (err) {
      if (err.code === 10062) {
        await interaction.channel.send({
          content: '⚠️ This Confirm Deal button has expired. Please use a new one if available.',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('confirm_deal').setLabel('Confirm Deal').setStyle(ButtonStyle.Success)
            )
          ]
        });
        return;
      }
      throw err;
    }
    const channel = interaction.channel;
    const messages = await channel.messages.fetch({ limit: 50 });
    let sellerData = sellerMap.get(channel.id);
    if (!sellerData) {
      const orderNumber = getOrderIdFromChannelName(channel.name);
      const recs = await findDealRecords(orderNumber);
      const rec = recs[0];
      if (rec) {
        /*
          A record with a Member WTB ID came from the want-to-buy table, and
          the only deals that live there with a claimed seller are snapshots.
          Saying so here keeps the photo gate skipped and sends Make the
          right link field after a restart has emptied sellerMap.
        */
        const isMemberWtbDeal = !!rec.get('Member WTB ID');

        sellerData = {
          sellerRecordId: (rec.get('Claimed Seller ID') || [])[0],
          orderRecordId: rec.id,
          sellerDiscordId: rec.get('Claimed Seller Discord ID'),
          dealEmbedId: rec.get('Claimed Message ID'),
          vatType: rec.get('Claimed Seller VAT Type'),
          isQuickDeal: !isMemberWtbDeal,
          isSnapshotDeal: isMemberWtbDeal,
          ...(isMemberWtbDeal ? { snapshotSource: 'member_wtb' } : {})
        };
        sellerMap.set(channel.id, sellerData);
      }
    }
    if (sellerData?.dealConfirmed) return interaction.editReply({ content: '⚠️ This deal has already been confirmed.' });
    if (!sellerData || !sellerData.orderRecordId || !sellerData.sellerRecordId) return interaction.editReply({ content: '❌ Missing claimed Seller or Order ID.' });
    /*
      A Quick Deal is confirmed on the strength of the seller's photos, so
      one has to be there. A Snapshot has no photo wall - it is a fixed price
      the seller either takes or does not, and its whole point is that this
      happens in minutes. The image was only ever a gate here; nothing below
      reads it.
    */
    if (!sellerData?.isSnapshotDeal) {
      const imageMsg = messages.find(
        (m) => m.attachments.size > 0 && [...m.attachments.values()].some((att) => att.contentType?.startsWith('image/'))
      );

      if (!imageMsg) return interaction.editReply({ content: '❌ No image found in recent messages.' });
    }
    let embed;
    const storedId = sellerMap.get(channel.id)?.dealEmbedId;
    if (storedId) {
      const m = await channel.messages.fetch(storedId).catch(() => null);
      embed = m?.embeds?.[0];
    }
    if (!embed) {
      const msgs = await fetchUpTo(channel, 500);
      const m = msgs.find(
        (msg) =>
          msg.author.id === client.user.id &&
          Array.isArray(msg.embeds) &&
          msg.embeds.some(
            (e) =>
              (e?.title?.includes('Deal Claimed') || e?.title?.includes('Quick Deal Claimed')) &&
              e?.description?.includes('**Order:**') &&
              e?.description?.includes('**Payout:**')
          )
      );
      embed = m?.embeds?.find((e) => e?.title?.includes('Deal Claimed') || e?.title?.includes('Quick Deal Claimed'));
    }
    if (!embed?.description) return interaction.editReply({ content: '❌ Missing deal embed.' });
    const lines = embed.description.split('\n');
    const getValue = (label) => lines.find((line) => line.includes(label))?.split(label)[1]?.trim() || '';
    const sku = getValue('**SKU:**');
    const size = getValue('**Size:**');
    const brand = getValue('**Brand:**');
    const orderNumber = getValue('**Order:**');
    let payout = sellerData?.payoutChosen;
    if (payout == null) {
      const payoutStr = getValue('**Payout:**')?.replace('€', '').replace(',', '.');
      payout = parseFloat(payoutStr || '0');
    }
    let vatType = sellerData?.vatType || getValue('**VAT Type:**') || 'Margin';
    let finalPayout = payout;
    let shippingDeduction = 0;
    let trustNote = '';
    try {
      const sellerDiscordId = sellerData?.sellerDiscordId;
      if (sellerDiscordId) {
        const member = await interaction.guild.members.fetch(sellerDiscordId);
        const trustedRoleId = TRUSTED_SELLERS_ROLE_ID;
        let isTrusted = false;
        if (trustedRoleId) isTrusted = member.roles.cache.has(trustedRoleId);
        if (trustedRoleId && !isTrusted) {
          finalPayout = Math.max(0, payout - 10);
          shippingDeduction = 10;
          trustNote = '⚠️ Because you are not a Trusted Seller yet, we had to deduct €10 from the payout for the extra label and handling.';
        }
      }
    } catch (err) {
      console.warn('Could not check trusted role:', err);
    }
    const orderRecord = await base(ORDER_TABLE_NAME).find(sellerData.orderRecordId);
    const productName = orderRecord.get('Product Name') || orderRecord.get('Shopify Product Name') || '';
    let sellerRecord;
    try {
      sellerRecord = await base('Sellers Database').find(sellerData.sellerRecordId);
    } catch (_) {}
    if (!sellerRecord) return interaction.editReply({ content: '❌ Linked Seller not found in our system.' });
    if (MAKE_QUICK_DEAL_WEBHOOK_URL) {
      try {
        await fetch(MAKE_QUICK_DEAL_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: sellerData.isSnapshotDeal
              ? 'Snapshot Deal'
              : sellerData.isQuickDeal ? 'Quick Deal' : 'Claim Deal',

            /*
              Which record the unit hangs off.

              A snapshot can come from a want-to-buy, and Inventory Units has
              a separate link for those. Make maps each of these to its own
              field, so exactly one is filled and the other stays empty -
              rather than Make having to work out which side it is on.
            */
            orderRecordId: sellerData.isSnapshotDeal && sellerData.snapshotSource === 'member_wtb'
              ? ''
              : sellerData.orderRecordId,

            memberWtbRecordId: sellerData.isSnapshotDeal && sellerData.snapshotSource === 'member_wtb'
              ? sellerData.orderRecordId
              : '',
            sellerRecordId: sellerData.sellerRecordId,
            orderNumber,
            productName,
            sku,
            size,
            brand,
            payout: finalPayout,
            rawPayout: payout,
            shippingDeduction,
            vatType,
            isTrustedSeller: shippingDeduction === 0,
            sellerDiscordId: sellerData.sellerDiscordId,
            channelId: channel.id
          })
        });
      } catch (e) {
        console.error('❌ Error sending data to Make webhook:', e);
      }
    } else {
      console.warn('⚠️ MAKE_QUICK_DEAL_WEBHOOK_URL is not set; skipping webhook call.');
    }
    sellerMap.set(channel.id, { ...sellerData, dealConfirmed: true });
    try {
      await base(ORDER_TABLE_NAME).update(sellerData.orderRecordId, { 'Claimed Seller Confirmed?': true });
    } catch (e) {
      console.warn('⚠️ Could not update Claimed Seller Confirmed? in Airtable:', e.message);
    }
    const recentMessages = await channel.messages.fetch({ limit: 10 });
    const buttonMessage = recentMessages.find((msg) => msg.components.length > 0);
    if (buttonMessage) await buttonMessage.edit({ components: [] });
    const requestLabelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`request_label_quick_deal:${sellerData.orderRecordId}`)
        .setLabel('Request Label')
        .setStyle(ButtonStyle.Primary)
    );
    
    const readyEmbed = new EmbedBuilder()
      .setTitle('📦 Ready to Ship')
      .setColor(0x2ecc71)
      .addFields(
        {
          name: '💶 Final Payout',
          value: `€${finalPayout.toFixed(2)}${trustNote || ''}`,
          inline: false
        },
        {
          name: '📦 Next Step',
          value: 'Click **Request Label** when you are ready to ship.',
          inline: false
        },
        {
          name: '📬 Packaging Instructions',
          value:
            'Use a clean, unbranded box.\nRemove unnecessary stickers or markings.\nDo not include anything extra inside.\nPack it as professionally as possible.',
          inline: false
        }
      )
      .setFooter({ text: 'Kickz Caviar' });
    
    await interaction.editReply({
      embeds: [readyEmbed],
      components: [requestLabelRow]
    });
    return;
  }
});
/* =================================================
   MESSAGE HANDLER – PICTURE COUNT + !finish
   ================================================= */
client.on(Events.MessageCreate, async (message) => {
  if (message.channel.name.toUpperCase().startsWith('ORD-') && message.attachments.size > 0) {
    let data = sellerMap.get(message.channel.id);
    if (!data?.sellerRecordId) {
      const orderNumber = getOrderIdFromChannelName(message.channel.name);
      const recs = await findDealRecords(orderNumber);
      if (recs.length) {
        data = {
          ...(data || {}),
          orderRecordId: recs[0].id,
          sellerRecordId: (recs[0].get('Claimed Seller ID') || [])[0],
          sellerDiscordId: recs[0].get('Claimed Seller Discord ID'),
          dealEmbedId: recs[0].get('Claimed Message ID'),
          confirmed: !!recs[0].get('Claimed Seller Confirmed?')
        };
        sellerMap.set(message.channel.id, data);
      }
    }
    const currentUploads = uploadedImagesMap.get(message.channel.id) || [];
    const imageUrls = [...message.attachments.values()]
      .filter((att) => att.contentType?.startsWith('image/'))
      .map((att) => att.url);
    if (imageUrls.length > 0) {
      currentUploads.push(...imageUrls);
      uploadedImagesMap.set(message.channel.id, currentUploads);
    }
    const uploadedCount = currentUploads.length;
    if (!message.author.bot && uploadedCount < 6) {
      await message.channel.send(`📸 You've uploaded ${uploadedCount}/6 required pictures.`);
    }
    if (uploadedCount >= 6 && !data?.confirmSent) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_deal').setLabel('Confirm Deal').setStyle(ButtonStyle.Success)
      );
      await message.channel.send({
        content: '✅ All 6 pictures received. Admin can now confirm the deal.',
        components: [row]
      });
      sellerMap.set(message.channel.id, { ...data, confirmSent: true });
    }
  }
  if (message.content === '!close' && message.channel.name.toLowerCase().startsWith('ord-')) {
    const memberRoles = message.member.roles.cache.map((r) => r.id);
    const isAdmin = ADMIN_ROLE_IDS.some((id) => id && memberRoles.includes(id));
    if (!isAdmin) return message.reply('❌ You are not authorized to use this command.');
    await message.delete().catch(() => {});
  
    await message.channel.send(
      `⚠️ **Alert!**\n\n` +
      `😭  Not possible to confirm the deal, the order is already **fulfilled by client** or has some other error.\n\n` +
      `➡️  We wait you on a next deal.\n\n` +
      `🕒 **This channel will be deleted shortly.**`
    );
  
    // shorter delay than !finish (e.g. 30 seconds)
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
            content: `🗒️ Transcript for **closed (warehouse fulfilled)** deal **${message.channel.name}**`,
            files: [transcript]
          });
        }
  
        await message.channel.delete();
      } catch (err) {
        console.error(`❌ Error closing deal ${message.channel.name}:`, err);
      }
    }, 300000); // 5 mins
  }
  if (message.content === '!check' && message.channel.name.toLowerCase().startsWith('ord-')) {
    const memberRoles = message.member.roles.cache.map((r) => r.id);
    const isAdmin = ADMIN_ROLE_IDS.some((id) => id && memberRoles.includes(id));
    if (!isAdmin) return message.reply('❌ You are not authorized to use this command.');
  
    // delete the command message (clean UX)
    await message.delete().catch(() => {});
  
    try {
      const orderNumber = getOrderIdFromChannelName(message.channel.name);
  
      const recs = await findDealRecords(orderNumber);
  
      if (!recs.length) {
        return message.author.send(`❌ No order record found for **${orderNumber}**.`);
      }
  
      const rec = recs[0];
      const status = rec.get('Fulfillment Status') || '—';
  
      if (status === 'Store Fulfilled') {
        await message.author.send(
          `❌ Order **${orderNumber}** is **Store Fulfilled**\n` +
          `This deal should **NOT** be confirmed.`
        );
      } else {
        await message.author.send(
          `✅ **Order ${orderNumber}** can **proceed normally**`
        );
      }
    } catch (err) {
      console.error('!check command failed:', err);
      try {
        await message.author.send('❌ Error while checking Fulfillment Status.');
      } catch (_) {}
    }
  }
  
  const channelName = message.channel.name.toLowerCase();
  if (
    message.content === '!finish' &&
    (
      channelName.startsWith('ord-') ||
      channelName.startsWith('wtb-ord-') ||
      channelName.startsWith('mwtb-')
    )
  ) {
    const memberRoles = message.member.roles.cache.map((r) => r.id);
    const isAdmin = ADMIN_ROLE_IDS.some((id) => id && memberRoles.includes(id));
    if (!isAdmin) return message.reply('❌ You are not authorized to use this command.');
    // 🧹 delete the command message
    await message.delete().catch(() => {});
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
            content: `🗒️ Final transcript for finished deal **${message.channel.name}**`,
            files: [transcript]
          });
        }
        await message.channel.delete();
      } catch (err) {
        console.error(`❌ Error finishing deal ${message.channel.name}:`, err);
      }
    }, 3600000);
  }
});
/* ---------------- START BOT + SERVER ---------------- */
client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);

  // Hier en niet alleen op module-niveau: deze regel verschijnt op het moment
  // dat Render "Your service is live" meldt, dus precies waar je kijkt. De
  // module-melding staat daarboven en wordt makkelijk overgescrold.
  console.log(
    KC_PORTAL_SECRET
      ? `✅ Portal-koppeling actief: ${KC_PORTAL_BASE_URL}`
      : '❌ KC_PORTAL_SECRET ontbreekt — seller-lookup en profiel claimen werken niet.'
  );
});
