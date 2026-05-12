require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Use webhook mode on Render (RENDER_URL is set), polling mode locally
const isProduction = !!process.env.RENDER_URL;
const bot = new TelegramBot(token, isProduction ? {} : { polling: true });

const app = express();
app.use(express.json());

// Health check — Render pings this to confirm the service is up
app.get('/', (req, res) => res.send('ShopBot is running.'));

if (isProduction) {
  const renderUrl = process.env.RENDER_URL.replace(/\/$/, '');
  const webhookPath = `/webhook/${token}`;

  app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  bot.setWebHook(`${renderUrl}${webhookPath}`)
    .then(() => console.log(`Webhook registered at ${renderUrl}/webhook/***`))
    .catch((err) => console.error('Webhook registration failed:', err.message));
} else {
  console.log('ShopBot running in polling mode (local dev).');
}

// Base URL used for building approval links
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_URL
  ? process.env.RENDER_URL.replace(/\/$/, '')
  : `http://localhost:${PORT}`;

// --- Phase 7: Approval page ---

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderApprovalPage(product, updated) {
  const statusColors = { draft: '#fef9c3;color:#854d0e', approved: '#dcfce7;color:#166534', rejected: '#fee2e2;color:#991b1b' };
  const statusStyle = statusColors[product.status] || statusColors.draft;
  const keywordList = Array.isArray(product.keywords) ? product.keywords.join(', ') : product.keywords;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Review: ${escapeHtml(product.title)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f9fafb;padding:24px;color:#111}
    .card{background:#fff;border-radius:12px;padding:24px;max-width:560px;margin:0 auto;box-shadow:0 1px 4px rgba(0,0,0,.1)}
    h1{font-size:1.25rem;margin-bottom:20px}
    .notice{background:#dcfce7;color:#166534;border-radius:8px;padding:12px;margin-bottom:16px;font-size:.9rem}
    .field{margin-bottom:14px}
    .label{font-size:.75rem;font-weight:600;text-transform:uppercase;color:#6b7280;margin-bottom:3px}
    .value{font-size:.95rem;line-height:1.5}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.8rem;background:${statusStyle}}
    .actions{display:flex;gap:12px;margin-top:24px}
    button{flex:1;padding:14px;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
    .approve{background:#16a34a;color:#fff}
    .reject{background:#dc2626;color:#fff}
  </style>
</head>
<body>
<div class="card">
  <h1>Review Product Listing</h1>
  ${updated ? '<div class="notice">Status updated successfully.</div>' : ''}
  <div class="field"><div class="label">Status</div><div class="value"><span class="badge">${escapeHtml(product.status)}</span></div></div>
  <div class="field"><div class="label">Title</div><div class="value">${escapeHtml(product.title)}</div></div>
  <div class="field"><div class="label">Description</div><div class="value">${escapeHtml(product.description)}</div></div>
  <div class="field"><div class="label">Category</div><div class="value">${escapeHtml(product.category)}</div></div>
  <div class="field"><div class="label">Keywords</div><div class="value">${escapeHtml(keywordList)}</div></div>
  <div class="field"><div class="label">Suggested Price</div><div class="value">₹${escapeHtml(product.suggested_price_inr)}</div></div>
  ${product.amazon_sku ? `<div class="field"><div class="label">Amazon SKU</div><div class="value">${escapeHtml(product.amazon_sku)} <span style="color:#6b7280">(${escapeHtml(product.amazon_status)})</span></div></div>` : ''}
  ${product.flipkart_sku ? `<div class="field"><div class="label">Flipkart SKU</div><div class="value">${escapeHtml(product.flipkart_sku)} <span style="color:#6b7280">(${escapeHtml(product.flipkart_status)})</span></div></div>` : ''}
  <form action="/approve/${escapeHtml(product.id)}/action" method="POST">
    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve">✅ Approve</button>
      <button type="submit" name="action" value="reject" class="reject">❌ Reject</button>
    </div>
  </form>
</div>
</body>
</html>`;
}

app.get('/approve/:id', async (req, res) => {
  const { data: product, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !product) return res.status(404).send('<h1>Product not found</h1>');

  res.send(renderApprovalPage(product, req.query.updated === 'true'));
});

app.post('/approve/:id/action', express.urlencoded({ extended: false }), async (req, res) => {
  const newStatus = req.body.action === 'approve' ? 'approved' : 'rejected';

  const { error } = await supabase
    .from('products')
    .update({ status: newStatus })
    .eq('id', req.params.id);

  if (error) return res.status(500).send('<h1>Failed to update status. Please try again.</h1>');

  res.redirect(`/approve/${req.params.id}?updated=true`);
});

app.listen(PORT, () => console.log(`Express listening on port ${PORT}`));

// --- Helper: resolve MIME type from file extension ---
const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function getMediaType(filePath) {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()] || 'image/jpeg';
}

// --- Step 1: Validate that the photo is a product image ---
async function validateProductPhoto(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: getMediaType(imagePath), data: buffer.toString('base64') },
          },
          { type: 'text', text: 'Is this a product photo suitable for an e-commerce listing? Reply with only YES or NO.' },
        ],
      },
    ],
  });
  return response.content[0].text.trim().toUpperCase().startsWith('YES');
}

// --- Step 2: Remove background via remove.bg ---
async function removeBackground(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const form = new FormData();
  form.append('image_file', buffer, { filename: path.basename(imagePath), contentType: 'image/jpeg' });

  const response = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
    headers: { ...form.getHeaders(), 'X-Api-Key': process.env.REMOVE_BG_API_KEY },
    responseType: 'arraybuffer',
  });

  const baseName = path.basename(imagePath, path.extname(imagePath));
  const outputPath = path.join(downloadsDir, `${baseName}-nobg.png`);
  fs.writeFileSync(outputPath, response.data);
  return outputPath;
}

// --- Step 3a: Generate multiple product angles via Stability AI ---
const ANGLES = [
  { label: 'front', prompt: 'product photo, front view, plain white background, professional e-commerce lighting' },
  { label: 'side', prompt: 'product photo, side view, plain white background, professional e-commerce lighting' },
  { label: '3q', prompt: 'product photo, three-quarter angle view, plain white background, professional e-commerce lighting' },
];

async function generateProductAngles(imagePath) {
  if (!process.env.STABILITY_API_KEY) {
    console.log('STABILITY_API_KEY not set — skipping angle generation.');
    return [];
  }

  const baseName = path.basename(imagePath, path.extname(imagePath));
  const generatedPaths = [];

  for (const angle of ANGLES) {
    try {
      const form = new FormData();
      form.append('init_image', fs.readFileSync(imagePath), {
        filename: path.basename(imagePath),
        contentType: 'image/png',
      });
      form.append('init_image_mode', 'IMAGE_STRENGTH');
      form.append('image_strength', '0.35');
      form.append('text_prompts[0][text]', angle.prompt);
      form.append('text_prompts[0][weight]', '1');
      form.append('text_prompts[1][text]', 'blurry, low quality, watermark, text, logo');
      form.append('text_prompts[1][weight]', '-1');
      form.append('cfg_scale', '7');
      form.append('samples', '1');
      form.append('steps', '30');

      const response = await axios.post(
        'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
        form,
        {
          headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'application/json' },
        }
      );

      const artifact = response.data.artifacts[0];
      const outputPath = path.join(downloadsDir, `${baseName}-${angle.label}.png`);
      fs.writeFileSync(outputPath, Buffer.from(artifact.base64, 'base64'));
      generatedPaths.push({ label: angle.label, path: outputPath });
      console.log(`Angle generated: ${angle.label}`);
    } catch (err) {
      console.error(`Angle generation failed (${angle.label}):`, err.message);
    }
  }

  return generatedPaths;
}

// --- Step 3b: Generate structured product listing with Claude ---
async function generateProductListing(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const prompt = `You are a product listing assistant for an Indian stationery shop. Analyze this product image and generate a JSON object. Respond with ONLY valid JSON, no markdown, no explanation.

Required JSON structure:
{
  "title": "short product name, maximum 80 characters",
  "description": "2-3 sentence product description",
  "category": "product category like Stationery > Pens or Stationery > Notebooks",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "suggested_price_inr": 0
}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: getMediaType(imagePath), data: buffer.toString('base64') },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const rawText = response.content[0].text.replace(/```json?|```/g, '').trim();
  return JSON.parse(rawText);
}

// --- Phase 3: Save product listing to Supabase inventory ---
async function saveToInventory(listing, imagePath) {
  const { data, error } = await supabase
    .from('products')
    .insert({
      title: listing.title,
      description: listing.description,
      category: listing.category,
      keywords: listing.keywords,
      suggested_price_inr: listing.suggested_price_inr,
      image_filename: path.basename(imagePath),
      status: 'draft',
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  return data;
}

// --- Phase 4: Amazon SP-API draft listing ---

async function getAmazonAccessToken() {
  const response = await axios.post('https://api.amazon.com/auth/o2/token', {
    grant_type: 'refresh_token',
    refresh_token: process.env.AMAZON_LWA_REFRESH_TOKEN,
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET,
  });
  return response.data.access_token;
}

async function createAmazonDraftListing(listing, productId) {
  const accessToken = await getAmazonAccessToken();
  const sku = `SHOPBOT-${productId.substring(0, 8).toUpperCase()}`;
  const mid = process.env.AMAZON_MARKETPLACE_ID;

  const bulletPoints = listing.description
    .split('. ')
    .filter((s) => s.trim().length > 0)
    .slice(0, 3)
    .map((pt) => ({ value: pt.trim().replace(/\.$/, ''), language_tag: 'en_IN', marketplace_id: mid }));

  const response = await axios.put(
    `https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/${process.env.AMAZON_SELLER_ID}/${sku}`,
    {
      productType: 'OFFICE_PRODUCT',
      requirements: 'LISTING',
      attributes: {
        item_name: [{ value: listing.title, language_tag: 'en_IN', marketplace_id: mid }],
        brand: [{ value: 'Generic', marketplace_id: mid }],
        list_price: [{ value: listing.suggested_price_inr, currency: 'INR', marketplace_id: mid }],
        fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 0, marketplace_id: mid }],
        bullet_point: bulletPoints,
        generic_keyword: listing.keywords.map((kw) => ({ value: kw, language_tag: 'en_IN', marketplace_id: mid })),
      },
    },
    {
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      params: { marketplaceIds: mid },
    }
  );

  const { status, submissionId, issues } = response.data;
  if (issues && issues.length > 0) {
    console.warn('Amazon listing issues:', JSON.stringify(issues));
  }

  await supabase.from('products').update({ amazon_sku: sku, amazon_status: status }).eq('id', productId);

  return { sku, status, submissionId };
}

// --- Phase 5: Flipkart Seller API draft listing ---

async function getFlipkartAccessToken() {
  const credentials = Buffer.from(
    `${process.env.FLIPKART_CLIENT_ID}:${process.env.FLIPKART_CLIENT_SECRET}`
  ).toString('base64');

  const response = await axios.get('https://api.flipkart.net/oauth-service/oauth/token', {
    params: { grant_type: 'client_credentials', scope: 'Seller_Api' },
    headers: { Authorization: `Basic ${credentials}` },
  });
  return response.data.access_token;
}

async function createFlipkartDraftListing(listing, productId) {
  const accessToken = await getFlipkartAccessToken();
  const sku = `SHOPBOT-FK-${productId.substring(0, 8).toUpperCase()}`;

  const response = await axios.post(
    'https://api.flipkart.net/sellers/listings/v3',
    [
      {
        skuId: sku,
        mrp: listing.suggested_price_inr,
        sellingPrice: listing.suggested_price_inr,
        quantity: 0,
        enabled: false,
        fulfillmentType: 'Seller',
        deliveryLag: 3,
        listing: {
          title: listing.title,
          description: listing.description,
          brand: 'Generic',
          keywords: listing.keywords.join(', '),
          category: listing.category,
        },
      },
    ],
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    }
  );

  // Flipkart returns per-SKU status in the response array
  const result = Array.isArray(response.data) ? response.data[0] : response.data;
  const status = result.status || result.state || 'SUBMITTED';

  if (result.errors && result.errors.length > 0) {
    console.warn('Flipkart listing issues:', JSON.stringify(result.errors));
  }

  await supabase.from('products').update({ flipkart_sku: sku, flipkart_status: status }).eq('id', productId);

  return { sku, status };
}

// --- Format listing as Telegram message ---
function formatListingMessage(listing, productId, amazonResult, flipkartResult) {
  const lines = [
    '✅ *Product Listing Generated!*\n',
    `📦 *Title:* ${listing.title}`,
    `📝 *Description:* ${listing.description}`,
    `🗂️ *Category:* ${listing.category}`,
    `🔍 *Keywords:* ${listing.keywords.join(', ')}`,
    `💰 *Suggested Price:* ₹${listing.suggested_price_inr}`,
    `\n🗃️ *Saved to inventory* (ID: \`${productId}\`)`,
  ];

  if (amazonResult) {
    lines.push(`🛒 *Amazon draft created* (SKU: \`${amazonResult.sku}\`, Status: ${amazonResult.status})`);
  } else {
    lines.push('⚠️ *Amazon listing skipped* (saved locally only)');
  }

  if (flipkartResult) {
    lines.push(`🛍️ *Flipkart draft created* (SKU: \`${flipkartResult.sku}\`, Status: ${flipkartResult.status})`);
  } else {
    lines.push('⚠️ *Flipkart listing skipped* (saved locally only)');
  }

  lines.push(`\n🔗 *Review & approve:* ${BASE_URL}/approve/${productId}`);

  return lines.join('\n');
}

// --- Main photo handler ---
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const photo = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;

  try {
    // Phase 1: Download
    const fileInfo = await bot.getFile(fileId);
    const remotePath = fileInfo.file_path;
    const filename = path.basename(remotePath);
    const localPath = path.join(downloadsDir, filename);

    const fileUrl = `https://api.telegram.org/file/bot${token}/${remotePath}`;
    const downloadRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(localPath, downloadRes.data);

    console.log(`Photo received: ${filename}`);
    await bot.sendMessage(chatId, 'Got your photo! Processing...');

    // Phase 2, Step 1: Validate with Claude
    const isProduct = await validateProductPhoto(localPath);
    if (!isProduct) {
      await bot.sendMessage(chatId, "This doesn't look like a product photo. Please send a clear product image.");
      return;
    }

    // Phase 2, Step 2: Remove background (non-fatal fallback)
    let imageForListing = localPath;
    try {
      imageForListing = await removeBackground(localPath);
      console.log(`Background removed: ${path.basename(imageForListing)}`);
    } catch (bgErr) {
      console.error('Background removal failed:', bgErr.message);
      await bot.sendMessage(chatId, 'Background removal failed, continuing with original image...');
    }

    // Phase 2, Step 3: Generate multi-angle images via Stability AI (non-fatal)
    let angleImages = [];
    try {
      angleImages = await generateProductAngles(imageForListing);
      if (angleImages.length > 0) {
        await bot.sendMessage(chatId, `Generated ${angleImages.length} angle image(s). Generating listing...`);
      }
    } catch (angleErr) {
      console.error('Angle generation failed:', angleErr.message);
    }

    // Phase 2, Step 4: Generate listing with Claude
    const listing = await generateProductListing(imageForListing);

    // Phase 3: Save to Supabase inventory
    const product = await saveToInventory(listing, imageForListing);
    console.log(`Saved to inventory: ${product.id}`);

    // Phase 4: Create Amazon draft listing (non-fatal)
    let amazonResult = null;
    try {
      amazonResult = await createAmazonDraftListing(listing, product.id);
      console.log(`Amazon draft created: SKU=${amazonResult.sku}, status=${amazonResult.status}`);
    } catch (amzErr) {
      console.error('Amazon listing failed:', amzErr.message);
    }

    // Phase 5: Create Flipkart draft listing (non-fatal)
    let flipkartResult = null;
    try {
      flipkartResult = await createFlipkartDraftListing(listing, product.id);
      console.log(`Flipkart draft created: SKU=${flipkartResult.sku}, status=${flipkartResult.status}`);
    } catch (fkErr) {
      console.error('Flipkart listing failed:', fkErr.message);
    }

    // Send generated angle images back to user
    for (const img of angleImages) {
      await bot.sendPhoto(chatId, img.path, { caption: `📸 ${img.label} view` });
    }

    await bot.sendMessage(chatId, formatListingMessage(listing, product.id, amazonResult, flipkartResult), { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Error handling photo:', err.message);
    await bot.sendMessage(chatId, 'Something went wrong. Please try again.');
  }
});

bot.on('message', (msg) => {
  if (!msg.photo) {
    bot.sendMessage(msg.chat.id, 'Please send a photo of a product to get started.');
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});
