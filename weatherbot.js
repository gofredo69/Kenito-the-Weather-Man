require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const { Groq } = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const requiredEnv = ['TELEGRAM_TOKEN', 'OPENWEATHER_API_KEY', 'GROQ_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
requiredEnv.forEach(env => {
    if (!process.env[env]) {
        console.error(`CRITICAL ERROR: Missing ${env} in .env file!`);
        process.exit(1); 
    }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ITO YUNG MAGLALAGAY NG MENU BUTTON SA TELEGRAM
bot.setMyCommands([
    { command: 'start', description: 'Subscribe and setup location' },
    { command: 'weather', description: 'Check current weather now' },
    { command: 'help', description: 'Show all working commands' },
    { command: 'stop', description: 'Unsubscribe from daily updates' }
]);

const globalWeatherCache = new Map(); 
const CACHE_TTL = 10 * 60 * 1000; 
const userCooldowns = new Map(); 
const COOLDOWN_MS = 30 * 1000; 
let isBroadcasting = false; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function logToDB(action, status, details = {}) {
    console.log(`[${action}] ${status}`, details);
    try {
        await supabase.from('system_logs').insert([{ action, status, details }]);
    } catch (err) {
        console.error("Log to DB Failed:", err.message);
    }
}

async function withRetry(fn, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (error) {
            if (i === retries - 1) throw error;
            await sleep(delay * (i + 1)); 
        }
    }
}

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const { error } = await supabase.from('Subscribers').upsert({ id: chatId, is_active: true });
    
    if (!error) {
        bot.sendMessage(chatId, "Welcome to the Weather Service! You are now subscribed. Please share your location using the button below.", {
            reply_markup: { keyboard: [[{ text: "📍 Share My Location", request_location: true }]], resize_keyboard: true, one_time_keyboard: true }
        });
        await logToDB('USER_SUBSCRIBE', 'SUCCESS', { chatId });
    } else {
        console.error("SUPABASE ERROR SA /START:", error);
        bot.sendMessage(chatId, `Database Error: ${error.message}`);
    }
});

bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    await supabase.from('Subscribers').update({ is_active: false }).eq('id', chatId);
    bot.sendMessage(chatId, "You have been unsubscribed. Type /start to resubscribe.", { reply_markup: { remove_keyboard: true } });
    await logToDB('USER_UNSUBSCRIBE', 'SUCCESS', { chatId });
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = "Here are the buttons you can press:\n\n" +
                     "/start - Register and share location\n" +
                     "/weather - Get the latest weather update\n" +
                     "/help - Show this list of commands\n" +
                     "/stop - Unsubscribe from daily messages\n\n" +
                     "Tip: You can also tap the 'Menu' button next to your chat box to see these commands easily!";
    bot.sendMessage(chatId, helpText);
});

bot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { error } = await supabase.from('Subscribers').update({ latitude: msg.location.latitude, longitude: msg.location.longitude }).eq('id', chatId);
    if (!error) {
        bot.sendMessage(chatId, "✅ Location saved successfully. Press /weather to check current conditions.", { reply_markup: { remove_keyboard: true } });
        await logToDB('LOCATION_UPDATE', 'SUCCESS', { chatId });
    }
});

async function getWeatherData(lat, lon, useAI = false) {
    const locKey = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    const now = Date.now();

    if (globalWeatherCache.has(locKey)) {
        const cached = globalWeatherCache.get(locKey);
        if (now - cached.timestamp < CACHE_TTL) {
            if (!useAI) return cached.data; 
        }
    }

    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`;
    const res = await withRetry(() => axios.get(weatherUrl));
    const { temp, feels_like } = res.data.main;
    const condition = res.data.weather[0].description;
    const cityName = res.data.name;
    const formattedCondition = condition.charAt(0).toUpperCase() + condition.slice(1);

    const standardTemplate = `🌤️ Weather Update for ${cityName}\n🌡️ Temperature: ${temp}°C (Feels like ${feels_like}°C)\n☁️ Condition: ${formattedCondition}\n\nStay safe and have a great day!`;
    
    globalWeatherCache.set(locKey, { data: standardTemplate, timestamp: now, rawData: { temp, condition, cityName } });

    if (!useAI) return standardTemplate;

    const options = { timeZone: 'Asia/Manila', weekday: 'long', hour: 'numeric', minute: 'numeric', hour12: true };
    const phTime = new Date().toLocaleString('en-US', options);
    
    const prompt = `
    Act as a professional weather assistant. Use the data below to provide a short recommendation.
    Data: ${phTime}, ${cityName}, Temp: ${temp}°C (Feels ${feels_like}°C), ${formattedCondition}.
    
    You MUST output EXACTLY in this format. DO NOT add conversational fillers at the start, and DO NOT use asterisks for bolding:
    🌤️ Weather Update for ${cityName}
    🌡️ Temperature: ${temp}°C (Feels like ${feels_like}°C)
    ☁️ Condition: ${formattedCondition}

    💡 Recommendation: [Write 1-2 professional sentences of practical advice based on the weather and time.]
    `;

    const completion = await withRetry(() => groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.1-8b-instant',
    }));
    
    return completion.choices[0].message.content;
}

bot.onText(/\/weather/, async (msg) => {
    const chatId = msg.chat.id;
    const now = Date.now();

    if (userCooldowns.has(chatId)) {
        const lastReq = userCooldowns.get(chatId);
        if (now - lastReq < COOLDOWN_MS) {
            return bot.sendMessage(chatId, `⏳ Please wait ${((COOLDOWN_MS - (now - lastReq)) / 1000).toFixed(1)} seconds.`);
        }
    }
    userCooldowns.set(chatId, now); 

    const { data: user } = await supabase.from('Subscribers').select('latitude, longitude').eq('id', chatId).single();

    if (user?.latitude && user?.longitude) {
        bot.sendMessage(chatId, "Retrieving real-time data...");
        try {
            const message = await getWeatherData(user.latitude, user.longitude, true); 
            bot.sendMessage(chatId, message);
        } catch (err) {
            bot.sendMessage(chatId, "Failed to retrieve weather data.");
            await logToDB('MANUAL_WEATHER_FAIL', 'ERROR', { chatId, error: err.message });
        }
    } else {
        bot.sendMessage(chatId, "Location not found. Type /start to share your location.");
    }
});

async function broadcastWeather(useAI = false) {
    if (isBroadcasting) return;
    isBroadcasting = true;

    await logToDB('CRON_START', 'INFO', { useAI });
    const { data: users, error } = await supabase.from('Subscribers').select('id, latitude, longitude').eq('is_active', true).not('latitude', 'is', null).not('longitude', 'is', null);

    if (error || !users || users.length === 0) {
        isBroadcasting = false;
        return;
    }

    let stats = { success: 0, failed: 0, autoDeactivated: 0, total: users.length };
    const chunkSize = 25; 

    for (let i = 0; i < users.length; i += chunkSize) {
        const chunk = users.slice(i, i + chunkSize);
        const promises = chunk.map(async (user) => {
            try {
                const blastMessage = await getWeatherData(user.latitude, user.longitude, useAI);
                await bot.sendMessage(user.id, blastMessage);
                stats.success++;
            } catch (err) {
                stats.failed++;
                if (err.response && (err.response.statusCode === 403 || err.response.statusCode === 400)) {
                    await supabase.from('Subscribers').update({ is_active: false }).eq('id', user.id);
                    stats.autoDeactivated++;
                }
            }
        });

        await Promise.all(promises);
        if (i + chunkSize < users.length) await sleep(1000); 
    }

    await logToDB('CRON_COMPLETE', 'SUCCESS', stats);
    isBroadcasting = false;
}

cron.schedule('0 6 * * *', () => broadcastWeather(true), { timezone: "Asia/Manila" });
cron.schedule('0 12,18 * * *', () => broadcastWeather(false), { timezone: "Asia/Manila" });

console.log("God-Tier Enterprise Server Initialized. PM2 Ready.");
