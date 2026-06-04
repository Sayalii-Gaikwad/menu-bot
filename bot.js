import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Papa from 'papaparse';
import fetch from 'node-fetch';
import 'dotenv/config';

// 1. Initialize Bot & AI
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 2. Bot logic
bot.start((ctx) => {
  ctx.reply('Welcome to the Menu2CSV Bot! 🍕🌮\nSend me a photo of a restaurant menu card, and I will extract it into a CSV file for you!');
});

bot.on('photo', async (ctx) => {
  const messageMsg = await ctx.reply('📸 Received menu! Analyzing the image, please wait...');
  
  try {
    // Get the highest resolution photo (the last one in the array)
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    
    // Download image
    const imageResponse = await fetch(fileLink.href);
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');

    // AI Prompt
    const prompt = `
      Analyze this image of a restaurant menu card.
      Extract all the menu items and their prices.
      
      Return ONLY a raw JSON array of objects. Do not include markdown formatting like \`\`\`json.
      Each object should have the following exact keys:
      - "Category": (string) The category of the item in UPPERCASE (e.g., "SPECIAL DISHES"). If no category is found, use "UNCATEGORIZED".
      - "Name": (string) The name of the item in UPPERCASE (e.g., "MIX VEG").
      - "Price": (string or number) Just the numeric price value WITHOUT any currency symbols (e.g., 170).

      Ensure the output is a valid JSON array. Do NOT include descriptions or any other fields.
    `;

    const imagePart = {
      inlineData: {
        data: base64Data,
        mimeType: 'image/jpeg'
      }
    };

    // Try multiple Gemini models in order of preference in case of 503 or overload errors
    const modelsToTry = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.5-pro', 'gemini-1.5-pro'];
    let responseText = null;
    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        console.log(`Attempting extraction using model: ${modelName}`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([prompt, imagePart]);
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
      throw lastError || new Error('All Gemini models failed to process the image.');
    }

    let text = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const menuData = JSON.parse(text);

    // Convert to CSV
    const csv = Papa.unparse(menuData);
    const buffer = Buffer.from(csv, 'utf-8');

    // Send the CSV document back
    await ctx.replyWithDocument({ source: buffer, filename: 'menu_extract.csv' }, { reply_to_message_id: ctx.message.message_id });
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
});

// Launch the bot
bot.launch().then(() => {
  console.log('Telegram Bot is running...');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
