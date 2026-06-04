import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Papa from 'papaparse';
import fetch from 'node-fetch';
import 'dotenv/config';

// 1. Initialize Bot & AI
console.log('Starting bot initialization...');
console.log('Loaded Token:', process.env.TELEGRAM_BOT_TOKEN ? `${process.env.TELEGRAM_BOT_TOKEN.slice(0, 6)}...` : 'undefined');
console.log('Loaded Gemini API Key:', process.env.GEMINI_API_KEY ? 'Yes' : 'No');
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Debug logging middleware
bot.use((ctx, next) => {
  console.log(`[DEBUG] Received update type: ${ctx.updateType}`);
  if (ctx.message) {
    console.log(`[DEBUG] Message text: ${ctx.message.text || '(no text)'}`);
    console.log(`[DEBUG] Has photo: ${!!ctx.message.photo}`);
  }
  return next();
});

// 2. Bot logic
bot.start((ctx) => {
  ctx.reply('Welcome to the Image2CSV Bot! 📸📊\nSend me a photo of a menu, table, or list, and I will extract it into a CSV file for you!');
});

const mediaGroups = new Map();
const MEDIA_GROUP_DELAY = 1500; // Wait 1.5 seconds to collect all photos in the album

async function processMediaGroup(ctxList, fileIds) {
  const ctx = ctxList[ctxList.length - 1];
  const count = fileIds.length;
  
  const statusText = count > 1 
    ? `📸 Received ${count} images! Combining and analyzing the data, please wait...`
    : '📸 Received image! Analyzing the data, please wait...';
    
  const messageMsg = await ctx.reply(statusText);

  try {
    // Download all images in parallel
    const base64Images = await Promise.all(fileIds.map(async (fileId) => {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const imageResponse = await fetch(fileLink.href);
      const arrayBuffer = await imageResponse.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    }));

    // Get custom instructions from captions in the group
    const captions = ctxList
      .map(c => c.message.caption)
      .filter(caption => caption && caption.trim().length > 0);
    const customInstructions = captions.length > 0 ? captions.join('\n') : '';

    // AI Prompt
    let prompt = `
      Analyze these images and extract all structured data into a single combined tabular format.
      
      Return ONLY a raw JSON array of objects. Do not include markdown formatting like \`\`\`json.
      Each object should represent a row. If the images are menus, use the keys "Category", "Name", and "Price". Otherwise, use appropriate keys representing the columns of the data.
      Keys should be in Title Case or UPPERCASE.

      Ensure the output is a valid JSON array. Do NOT include descriptions or any other fields.
    `;

    if (customInstructions) {
      prompt += `
      
      CRITICAL CUSTOM INSTRUCTIONS FROM USER:
      Apply the following additional instructions to customize the data extraction:
      "${customInstructions}"
      `;
    }

    const contents = [
      prompt,
      ...base64Images.map(base64Data => ({
        inlineData: {
          data: base64Data,
          mimeType: 'image/jpeg'
        }
      }))
    ];

    // Try multiple Gemini models in order of preference in case of 503 or overload errors
    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-3.5-flash'];
    let responseText = null;
    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        console.log(`Attempting extraction using model: ${modelName}`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(contents);
        const response = await result.response;
        responseText = response.text();
        console.log(`Success with model: ${modelName}`);
        break; // Successfully got response, exit retry loop
      } catch (err) {
        console.error(`Error with model ${modelName}:`, err.message || err);
        lastError = err;
        
        // Notify the user about trying the fallback model
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          messageMsg.message_id,
          null,
          `⚠️ Model ${modelName} is busy or unavailable. Attempting fallback model...`
        ).catch(() => {});
      }
    }

    if (!responseText) {
      throw lastError || new Error('All Gemini models failed to process the image(s).');
    }

    let text = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const menuData = JSON.parse(text);

    // Convert to CSV
    const csv = Papa.unparse(menuData);
    const buffer = Buffer.from(csv, 'utf-8');

    // Send the CSV document back
    await ctx.replyWithDocument({ source: buffer, filename: 'extracted_data.csv' }, { reply_to_message_id: ctx.message.message_id });
    await ctx.deleteMessage(messageMsg.message_id);

  } catch (error) {
    console.error(error);
    ctx.telegram.editMessageText(
      ctx.chat.id, 
      messageMsg.message_id, 
      null, 
      `❌ Error extracting data: ${error.message || 'Unknown error'}`
    );
  }
}

bot.on(['photo', 'document'], async (ctx) => {
  let fileId = null;
  let isImage = false;

  if (ctx.message.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    fileId = photo.file_id;
    isImage = true;
  } else if (ctx.message.document) {
    const doc = ctx.message.document;
    if (doc.mime_type && doc.mime_type.startsWith('image/')) {
      fileId = doc.file_id;
      isImage = true;
    } else {
      return ctx.reply('❌ Please send an image file (PNG, JPEG, etc.) to extract data.');
    }
  }

  if (!isImage || !fileId) return;

  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    if (!mediaGroups.has(mediaGroupId)) {
      mediaGroups.set(mediaGroupId, {
        ctxList: [],
        fileIds: [],
        timer: null
      });
    }

    const group = mediaGroups.get(mediaGroupId);
    group.ctxList.push(ctx);
    group.fileIds.push(fileId);

    // Reset the delay timer
    if (group.timer) {
      clearTimeout(group.timer);
    }

    group.timer = setTimeout(async () => {
      mediaGroups.delete(mediaGroupId);
      await processMediaGroup(group.ctxList, group.fileIds);
    }, MEDIA_GROUP_DELAY);
  } else {
    // Single image, process immediately
    await processMediaGroup([ctx], [fileId]);
  }
});

// Launch the bot
console.log('Attempting to launch bot...');
bot.launch()
  .then(() => {
    console.log('Telegram Bot is running successfully!');
  })
  .catch((err) => {
    console.error('Failed to launch bot:', err);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
