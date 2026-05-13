require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const sharp = require('sharp');

// SDXL-allowed dimensions — pick nearest by area while preserving orientation
const SDXL_SIZES = [
  [1024,1024],[1152,896],[1216,832],[1344,768],[1536,640],
  [640,1536],[768,1344],[832,1216],[896,1152],
];
async function resizeForSDXL(imagePath) {
  const meta = await sharp(imagePath).metadata();
  const isPortrait = meta.height > meta.width;
  const area = meta.width * meta.height;

  // Filter to same orientation first, then pick closest area
  const samOrientation = SDXL_SIZES.filter(([w, h]) =>
    isPortrait ? h > w : w >= h
  );
  const [tw, th] = samOrientation.reduce((best, s) =>
    Math.abs(s[0]*s[1]-area) < Math.abs(best[0]*best[1]-area) ? s : best
  );
  return sharp(imagePath).resize(tw, th, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }).jpeg().toBuffer();
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

const ANGLES = [
  { label: 'Front view', prompt: 'product photo, front view, plain white background, professional e-commerce studio lighting' },
  { label: 'Side view', prompt: 'product photo, side view, plain white background, professional e-commerce studio lighting' },
  { label: '3/4 angle', prompt: 'product photo, three-quarter angle, plain white background, professional e-commerce studio lighting' },
];

console.log('\n🤖 ShopBot test is running...');
console.log('📸 Send a product photo with a caption to your bot on Telegram.\n');

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || '';

  try {
    await bot.sendMessage(chatId, caption
      ? `Got your photo + caption!\n\n📋 *Details noted:* ${caption}\n\nProcessing...`
      : 'Got your photo! Processing...',
      { parse_mode: 'Markdown' }
    );

    // --- Step 1: Download photo ---
    const photo = msg.photo[msg.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const downloadRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const imagePath = path.join(downloadsDir, path.basename(fileInfo.file_path));
    fs.writeFileSync(imagePath, downloadRes.data);
    console.log(`📥 Photo downloaded: ${path.basename(imagePath)}`);

    // --- Step 2: Generate listing with Claude ---
    await bot.sendMessage(chatId, '🧠 Generating product listing with Claude...');
    const imageBuffer = fs.readFileSync(imagePath);
    const extraSection = caption
      ? `\n\nThe seller has provided these additional details — treat them as ground truth:\n${caption}`
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

    const claudeRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const listing = JSON.parse(claudeRes.content[0].text.replace(/```json?|```/g, '').trim());
    console.log('✅ Listing generated');

    // Send listing to Telegram
    const listingMsg = [
      '✅ *Product Listing Generated!*\n',
      `📦 *Title:* ${listing.title}`,
      `\n📝 *Bullet Points:*`,
      ...listing.bullet_points.map(b => `  • ${b}`),
      `\n📄 *Description:* ${listing.description}`,
      `🗂️ *Category:* ${listing.category}`,
      `🔍 *Keywords:* ${listing.keywords.join(', ')}`,
      `💰 *Suggested Price:* ₹${listing.suggested_price_inr}`,
    ].join('\n');

    await bot.sendMessage(chatId, listingMsg, { parse_mode: 'Markdown' });

    // --- Step 3: Remove background via Stability AI dedicated endpoint ---
    await bot.sendMessage(chatId, '✂️ Removing background...');
    let cleanImagePath = imagePath;
    try {
      const removeBgForm = new FormData();
      removeBgForm.append('image', fs.readFileSync(imagePath), { filename: 'product.jpg', contentType: 'image/jpeg' });
      removeBgForm.append('output_format', 'png');

      const removeBgRes = await axios.post(
        'https://api.stability.ai/v2beta/stable-image/edit/remove-background',
        removeBgForm,
        { headers: { ...removeBgForm.getHeaders(), Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' }, responseType: 'arraybuffer' }
      );

      // Composite transparent PNG on white background using Sharp
      const baseName = path.basename(imagePath, path.extname(imagePath));
      const noBgPath = path.join(downloadsDir, `${baseName}-nobg.png`);
      const whiteBgPath = path.join(downloadsDir, `${baseName}-white.png`);

      fs.writeFileSync(noBgPath, Buffer.from(removeBgRes.data));

      // Get image dimensions then create white background + composite product on top
      const meta = await sharp(noBgPath).metadata();
      await sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
        .composite([{ input: noBgPath }])
        .png()
        .toFile(whiteBgPath);

      cleanImagePath = whiteBgPath;
      await bot.sendPhoto(chatId, whiteBgPath, { caption: '✅ Clean white background' });
      console.log('✅ Background removed, white background applied');
    } catch (err) {
      console.error('Background removal failed:', err.response?.data ? Buffer.from(err.response.data).toString() : err.message);
      await bot.sendMessage(chatId, '⚠️ Background removal failed, using original image for angles.');
    }

    // --- Step 4: Generate 3 lighting/style variations from the clean white-background image ---
    await bot.sendMessage(chatId, '🎨 Generating product variations...');

    const VARIATIONS = [
      { label: 'Slight left', prompt: 'same product slightly rotated left, white background, sharp details', strength: '0.25' },
      { label: 'Straight on', prompt: 'same product straight front view, bright white background, crisp clean', strength: '0.15' },
      { label: 'Slight right', prompt: 'same product slightly rotated right, white background, clear visibility', strength: '0.25' },
    ];

    for (const variation of VARIATIONS) {
      try {
        const resizedBuf = await resizeForSDXL(cleanImagePath);
        const form = new FormData();

        const prompt = [
          `${listing.title}`,
          `${listing.category}`,
          `pure white background, isolated product`,
          variation.prompt,
          `same product, no changes to product shape or color`,
        ].join(', ');

        form.append('image', resizedBuf, { filename: 'product.png', contentType: 'image/png' });
        form.append('mode', 'image-to-image');
        form.append('prompt', prompt);
        form.append('negative_prompt', 'blurry, low quality, watermark, text, logo, colorful background, dark background, hands, people, different product, cluttered');
        form.append('strength', variation.strength);
        form.append('output_format', 'png');

        const stabilityRes = await axios.post(
          'https://api.stability.ai/v2beta/stable-image/generate/sd3',
          form,
          { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' }, responseType: 'arraybuffer' }
        );

        const outputPath = path.join(downloadsDir, `${path.basename(imagePath, path.extname(imagePath))}-${variation.label.replace(/ /g, '-')}.png`);
        fs.writeFileSync(outputPath, Buffer.from(stabilityRes.data));
        await bot.sendPhoto(chatId, outputPath, { caption: `📸 ${variation.label}` });
        console.log(`✅ ${variation.label} generated`);
      } catch (err) {
        const errMsg = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
        console.error(`❌ ${variation.label} failed:`, errMsg);
        await bot.sendMessage(chatId, `⚠️ ${variation.label} failed — skipping.`);
      }
    }

    await bot.sendMessage(chatId, '🎉 *All done!* Listing and images are ready.', { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong. Check the terminal for details.');
  }
});

bot.on('message', (msg) => {
  if (!msg.photo) bot.sendMessage(msg.chat.id, '👋 Send a product photo (with optional caption) to get started!');
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
