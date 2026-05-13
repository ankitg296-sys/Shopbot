require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const FormData = require('form-data');
const sharp = require('sharp');

// --- Startup checks ---
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('ERROR: TELEGRAM_BOT_TOKEN is not set'); process.exit(1); }

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Webhook vs polling ---
const isProduction = !!process.env.RENDER_URL;
const bot = new TelegramBot(token, isProduction ? {} : { polling: true });

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('ShopBot is running.'));

if (isProduction) {
  const renderUrl = process.env.RENDER_URL.replace(/\/$/, '');
  const webhookPath = `/webhook/${token}`;
  app.post(webhookPath, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  bot.setWebHook(`${renderUrl}${webhookPath}`)
    .then(() => console.log(`Webhook registered at ${renderUrl}/webhook/***`))
    .catch(err => console.error('Webhook registration failed:', err.message));
} else {
  console.log('ShopBot running in polling mode (local dev).');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Express listening on port ${PORT}`));

// --- SDXL resize — orientation-aware ---
const SDXL_SIZES = [
  [1024,1024],[1152,896],[1216,832],[1344,768],[1536,640],
  [640,1536],[768,1344],[832,1216],[896,1152],
];
async function resizeForSDXL(imagePath) {
  const meta = await sharp(imagePath).metadata();
  const isPortrait = meta.height > meta.width;
  const area = meta.width * meta.height;
  const sameOrientation = SDXL_SIZES.filter(([w, h]) => isPortrait ? h > w : w >= h);
  const [tw, th] = sameOrientation.reduce((best, s) =>
    Math.abs(s[0]*s[1]-area) < Math.abs(best[0]*best[1]-area) ? s : best
  );
  return sharp(imagePath).resize(tw, th, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }).jpeg().toBuffer();
}

// --- Step 1: Validate product photo ---
async function validateProductPhoto(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') } },
        { type: 'text', text: 'Is this a product photo suitable for an e-commerce listing? Reply with only YES or NO.' },
      ],
    }],
  });
  return response.content[0].text.trim().toUpperCase().startsWith('YES');
}

// --- Step 2: Generate listing with Claude ---
async function generateProductListing(imagePath, extraDetails = '') {
  const buffer = fs.readFileSync(imagePath);
  const extraSection = extraDetails.trim()
    ? `\n\nThe seller has provided these additional details — treat them as ground truth:\n${extraDetails.trim()}`
    : '';

  const prompt = `You are a product listing assistant for an Indian stationery shop. Analyze this product image and generate a detailed JSON listing. Respond with ONLY valid JSON, no markdown, no explanation.${extraSection}

{
  "title": "compelling product title, max 80 characters",
  "bullet_points": ["feature 1", "feature 2", "feature 3", "feature 4", "feature 5"],
  "description": "3-4 sentence rich product description",
  "category": "e.g. Stationery > Pens",
  "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5", "kw6", "kw7", "kw8"],
  "suggested_price_inr": 0
}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  return JSON.parse(response.content[0].text.replace(/```json?|```/g, '').trim());
}

// --- Step 3: Remove background + apply white ---
async function removeBackgroundAndWhiten(imagePath) {
  const baseName = path.basename(imagePath, path.extname(imagePath));
  const noBgPath = path.join(downloadsDir, `${baseName}-nobg.png`);
  const whiteBgPath = path.join(downloadsDir, `${baseName}-white.png`);

  const form = new FormData();
  form.append('image', fs.readFileSync(imagePath), { filename: 'product.jpg', contentType: 'image/jpeg' });
  form.append('output_format', 'png');

  const res = await axios.post(
    'https://api.stability.ai/v2beta/stable-image/edit/remove-background',
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' }, responseType: 'arraybuffer' }
  );

  fs.writeFileSync(noBgPath, Buffer.from(res.data));

  const meta = await sharp(noBgPath).metadata();
  await sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: noBgPath }])
    .png()
    .toFile(whiteBgPath);

  return whiteBgPath;
}

// --- Step 4: Generate product variations ---
const VARIATIONS = [
  { label: 'Slight left',  prompt: 'same product slightly rotated left, white background, sharp details', strength: '0.25' },
  { label: 'Straight on',  prompt: 'same product straight front view, bright white background, crisp clean', strength: '0.15' },
  { label: 'Slight right', prompt: 'same product slightly rotated right, white background, clear visibility', strength: '0.25' },
];

async function generateVariations(cleanImagePath, listing, originalImagePath) {
  const results = [];
  for (const variation of VARIATIONS) {
    try {
      const resizedBuf = await resizeForSDXL(cleanImagePath);
      const form = new FormData();
      const prompt = [
        listing.title, listing.category,
        'pure white background, isolated product',
        variation.prompt,
        'same product, no changes to product shape or color',
      ].join(', ');

      form.append('image', resizedBuf, { filename: 'product.png', contentType: 'image/png' });
      form.append('mode', 'image-to-image');
      form.append('prompt', prompt);
      form.append('negative_prompt', 'blurry, low quality, watermark, text, logo, colorful background, dark background, hands, people, different product');
      form.append('strength', variation.strength);
      form.append('output_format', 'png');

      const stabilityRes = await axios.post(
        'https://api.stability.ai/v2beta/stable-image/generate/sd3',
        form,
        { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' }, responseType: 'arraybuffer' }
      );

      const baseName = path.basename(originalImagePath, path.extname(originalImagePath));
      const outputPath = path.join(downloadsDir, `${baseName}-${variation.label.replace(/ /g, '-')}.png`);
      fs.writeFileSync(outputPath, Buffer.from(stabilityRes.data));
      results.push({ label: variation.label, path: outputPath });
      console.log(`✅ Variation generated: ${variation.label}`);
    } catch (err) {
      console.error(`❌ Variation failed (${variation.label}):`, err.response?.data ? Buffer.from(err.response.data).toString() : err.message);
    }
  }
  return results;
}

// --- Format listing message ---
function formatListingMessage(listing) {
  return [
    '✅ *Product Listing Generated!*\n',
    `📦 *Title:* ${listing.title}`,
    `\n📝 *Bullet Points:*`,
    ...listing.bullet_points.map(b => `  • ${b}`),
    `\n📄 *Description:* ${listing.description}`,
    `🗂️ *Category:* ${listing.category}`,
    `🔍 *Keywords:* ${listing.keywords.join(', ')}`,
    `💰 *Suggested Price:* ₹${listing.suggested_price_inr}`,
  ].join('\n');
}

// --- Main photo handler ---
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const extraDetails = msg.caption || '';

  try {
    const ackMsg = extraDetails
      ? `Got your photo + details!\n\n📋 *Details noted:*\n${extraDetails}\n\nProcessing...`
      : 'Got your photo! Processing...';
    await bot.sendMessage(chatId, ackMsg, { parse_mode: 'Markdown' });

    // Download photo
    const photo = msg.photo[msg.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const downloadRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const imagePath = path.join(downloadsDir, path.basename(fileInfo.file_path));
    fs.writeFileSync(imagePath, downloadRes.data);
    console.log(`📥 Downloaded: ${path.basename(imagePath)}`);

    // Validate
    const isProduct = await validateProductPhoto(imagePath);
    if (!isProduct) {
      await bot.sendMessage(chatId, "⚠️ This doesn't look like a product photo. Please send a clear product image.");
      return;
    }

    // Generate listing
    await bot.sendMessage(chatId, '🧠 Generating listing with Claude...');
    const listing = await generateProductListing(imagePath, extraDetails);
    await bot.sendMessage(chatId, formatListingMessage(listing), { parse_mode: 'Markdown' });

    // Remove background + whiten
    await bot.sendMessage(chatId, '✂️ Removing background...');
    let cleanImagePath = imagePath;
    try {
      cleanImagePath = await removeBackgroundAndWhiten(imagePath);
      await bot.sendPhoto(chatId, cleanImagePath, { caption: '✅ Clean white background' });
    } catch (err) {
      console.error('Background removal failed:', err.message);
      await bot.sendMessage(chatId, '⚠️ Background removal failed, continuing with original.');
    }

    // Generate variations
    await bot.sendMessage(chatId, '🎨 Generating product variations...');
    const variations = await generateVariations(cleanImagePath, listing, imagePath);
    for (const v of variations) {
      await bot.sendPhoto(chatId, v.path, { caption: `📸 ${v.label}` });
    }

    await bot.sendMessage(chatId, '🎉 *All done!* Listing and images are ready.', { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

bot.on('message', (msg) => {
  if (!msg.photo) bot.sendMessage(msg.chat.id, '👋 Send a product photo (with optional caption) to get started!');
});

bot.on('polling_error', err => console.error('Polling error:', err.message));
