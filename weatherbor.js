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

// --- ELITE-LEVEL POLLING RECOVERY WITH GUARD LOCK ---
let isRestartingPolling = false;

bot.on('polling_error', async (error) => {
    console.log(`[POLLING_ERROR] Network issue detected: (${error.code})`);
    
    if ((error.code === 'EFATAL' || error.message.includes('ENOTFOUND')) && !isRestartingPolling) {
        isRestartingPolling = true;
        console.log("[SYSTEM] Attempting graceful polling restart in 5 seconds...");
        
        try {
            await bot.stopPolling();
            setTimeout(() => {
                bot.startPolling().then(() => {
                    console.log("[SYSTEM] Polling successfully restarted.");
                    isRestartingPolling = false;
                }).catch(err => {
                    console.error("[SYSTEM] Start polling failed:", err.message);
                    isRestartingPolling = false;
                });
            }, 5000);
        } catch (err) {
            console.error("[SYSTEM] Stop polling failed:", err.message);
            isRestartingPolling = false;
        }
    }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

bot.setMyCommands([
    { command: 'start', description: 'Subscribe and setup location' },
    { command: 'weather', description: 'Standard weather check' },
    { command: 'help', description: 'Show all working commands' },
    { command: 'stop', description: 'Unsubscribe from daily updates' }
]);

const globalWeatherCache = new Map(); 
const CACHE_TTL = 10 * 60 * 1000; 
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
    const firstName = msg.chat.first_name || 'Unknown';
    const userName = msg.chat.username || 'NoUsername';

    const { error } = await supabase.from('Subscribers').upsert({ 
        id: chatId, 
        first_name: firstName,
        username: userName,
        is_active: true 
    });
    
    if (!error) {
        bot.sendMessage(chatId, "Welcome to the Weather Service! You are now subscribed. Please share your location using the button below.", {
            reply_markup: { keyboard: [[{ text: "📍 Share My Location", request_location: true }]], resize_keyboard: true, one_time_keyboard: true }
        });
        await logToDB('USER_SUBSCRIBE', 'SUCCESS', { chatId, firstName });
    } else {
        console.error("SUPABASE ERROR:", error);
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
    const helpText = "Here are the commands you can use:\n\n" +
                     "/start - Register and share location\n" +
                     "/weather - Get the latest fast weather update\n" +
                     "/weather ai - Get an AI-generated weather recommendation\n" +
                     "/help - Show this list of commands\n" +
                     "/stop - Unsubscribe from daily messages";
    bot.sendMessage(chatId, helpText);
});

bot.onText(/\/weather(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1] ? match[1].toLowerCase() : '';
    const useAI = (param === 'ai'); 

    const { data, error } = await supabase.from('Subscribers').select('latitude, longitude').eq('id', chatId).single();

    if (error || !data || !data.latitude || !data.longitude) {
        bot.sendMessage(chatId, "📍 I don't have your location yet! Please type /start to share your location.");
        return;
    }

    try {
        const weatherMessage = await getWeatherData(data.latitude, data.longitude, useAI);
        bot.sendMessage(chatId, weatherMessage);
    } catch (err) {
        bot.sendMessage(chatId, "❌ Sorry, I couldn't fetch the weather right now due to a network error. Please try again later.");
    }
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
    
    const timeOptions = { timeZone: 'Asia/Manila', hour: 'numeric', minute: 'numeric', hour12: true };
    const fetchTime = new Date().toLocaleString('en-US', timeOptions);

    let rawWeatherData;

    // --- CACHE MISS/HIT LOGGING ---
    if (globalWeatherCache.has(locKey)) {
        const cached = globalWeatherCache.get(locKey);
        if (now - cached.timestamp < CACHE_TTL) {
            rawWeatherData = cached.rawData;
            console.log(`[CACHE_HIT] Served memory data for ${locKey}`);
        }
    }

    if (!rawWeatherData) {
        console.log(`[CACHE_MISS] Fetching fresh OpenWeather API data for ${locKey}`);
        try {
            const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`;
            const res = await withRetry(() => axios.get(weatherUrl));
            
            rawWeatherData = {
                temp: res.data.main.temp,
                feels_like: res.data.main.feels_like,
                condition: res.data.weather[0].description,
                cityName: res.data.name,
                formattedCondition: res.data.weather[0].description.charAt(0).toUpperCase() + res.data.weather[0].description.slice(1)
            };
            
            globalWeatherCache.set(locKey, { timestamp: now, rawData: rawWeatherData });
        } catch (weatherErr) {
            // SEPARATE API FAILURE LOGGING
            await logToDB('WEATHER_API_FAIL', 'ERROR', { locKey, error: weatherErr.message });
            throw new Error("OpenWeather API Failure");
        }
    }

    const { temp, feels_like, formattedCondition, cityName } = rawWeatherData;
    const standardTemplate = `🌤️ Weather Update for ${cityName}\n🌡️ Temperature: ${temp}°C (Feels like ${feels_like}°C)\n☁️ Condition: ${formattedCondition}\n🕒 Data checked at: ${fetchTime}\n\nStay safe and have a great day!`;

    if (!useAI) return standardTemplate;
    
    const prompt = `
    Act as a professional weather assistant. Use the data below to provide a short recommendation.
    Data: Location: ${cityName}, Temp: ${temp}°C (Feels ${feels_like}°C), ${formattedCondition}, Time Checked: ${fetchTime}.
    
    You MUST output EXACTLY in this format. DO NOT add conversational fillers at the start, and DO NOT use asterisks for bolding:
    🌤️ Weather Update for ${cityName}
    🌡️ Temperature: ${temp}°C (Feels like ${feels_like}°C)
    ☁️ Condition: ${formattedCondition}
    🕒 Data checked at: ${fetchTime}

    💡 Recommendation: [Write 1-2 professional sentences of practical advice based on the weather and time.]
    `;

    try {
        const completion = await withRetry(() => groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.1-8b-instant',
        }));
        return completion.choices[0].message.content;
    } catch (aiErr) {
        // SEPARATE AI FAILURE LOGGING + GRACEFUL FALLBACK
        await logToDB('AI_API_FAIL', 'ERROR', { locKey, error: aiErr.message });
        console.log(`[AI_API_FAIL] Falling back to standard weather template.`);
        return standardTemplate + "\n\n💡 (AI recommendation is temporarily unavailable due to network/server load.)";
    }
}

async function broadcastWeather(useAI = false) {
    if (isBroadcasting) {
        console.log("Skipping broadcast, previous run still active or stuck.");
        return;
    }
    isBroadcasting = true;

    try {
        await logToDB('CRON_START', 'INFO', { useAI });
        const { data: users, error } = await supabase.from('Subscribers').select('id, latitude, longitude').eq('is_active', true).not('latitude', 'is', null).not('longitude', 'is', null);

        if (error || !users || users.length === 0) {
            console.log("No active users found for broadcast.");
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
    } catch (criticalError) {
        console.error("Critical error during broadcast loop:", criticalError);
    } finally {
        isBroadcasting = false; 
    }
}

cron.schedule('0 6 * * *', () => broadcastWeather(true), { timezone: "Asia/Manila" });
cron.schedule('0 12,18 * * *', () => broadcastWeather(false), { timezone: "Asia/Manila" });

console.log("God-Tier Enterprise Server Initialized. PM2 Ready.");
