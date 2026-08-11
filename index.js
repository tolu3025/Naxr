require('dotenv').config();
const {
    default: makeWASocket,
    initAuthCreds,
    BufferJSON,
    proto,
    delay,
    downloadMediaMessage,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Webhook } = require('svix');

// ----------------------------------------------------
// 1. CONFIGURATION & MONGO DB
// ----------------------------------------------------
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

// Schemas
const Vendor = mongoose.model('Vendor', new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    jid: String,
    storeName: { type: String, required: true },
    category: String,
    businessType: { type: String, enum: ['RETAIL', 'CUSTOM', 'SERVICE_TRANSPORT'], default: 'RETAIL' },
    paymentPolicy: { type: String, enum: ['UPFRONT', 'PAY_ON_BOARD', 'FLEXIBLE'], default: 'UPFRONT' },
    allowNegotiation: { type: Boolean, default: false },
    maxDiscountPercent: { type: Number, default: 0 },
    description: String,
    bankDetails: String,
    subaccountCode: String,
    deliveryInfo: String,
    faqs: String,
    docsSent: { type: Boolean, default: false },
    isPro: { type: Boolean, default: false },
    aiActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
}));

const Product = mongoose.model('Product', new mongoose.Schema({
    vendorPhone: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    minPrice: { type: Number, default: 0 },
    isNegotiable: { type: Boolean, default: false },
    imageUrl: String
}));

const Order = mongoose.model('Order', new mongoose.Schema({
    vendorPhone: { type: String, required: true },
    customerPhone: { type: String, required: true },
    productName: String,
    amount: Number,
    paymentPolicy: { type: String, default: 'UPFRONT' },
    virtualAccountNumber: String,
    txRef: String,
    status: { type: String, enum: ['PENDING', 'PAID', 'BOOKED'], default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
}));

const RegSession = mongoose.model('RegSession', new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    step: { type: Number, default: 1 },
    storeName: String,
    category: String,
    businessType: { type: String, default: 'RETAIL' },
    paymentPolicy: { type: String, default: 'UPFRONT' },
    allowNegotiation: { type: Boolean, default: false },
    maxDiscountPercent: { type: Number, default: 0 },
    description: String,
    bankDetails: String,
    subaccountCode: String,
    deliveryInfo: String,
    faqs: String,
    vendorRealPhone: String,
    products: { type: Array, default: [] },
    pendingProductImage: String,
    updatedAt: { type: Date, default: Date.now }
}));

const Auth = mongoose.model('Auth', new mongoose.Schema({ _id: String, data: String }));

async function useMongoDBAuthState(sessionId = 'creds') {
    const writeData = async (data, id) => {
        await Auth.updateOne({ _id: `${sessionId}-${id}` }, { $set: { data: JSON.stringify(data, BufferJSON.replacer) } }, { upsert: true });
    };
    const readData = async (id) => {
        const doc = await Auth.findOne({ _id: `${sessionId}-${id}` });
        return doc && doc.data ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    };
    const removeData = async (id) => { await Auth.deleteOne({ _id: `${sessionId}-${id}` }); };
    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds, keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            tasks.push(value ? writeData(value, `${category}-${id}`) : removeData(`${category}-${id}`));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

const uploadToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: "naxr_products" }, (error, result) => {
            if (result) resolve(result.secure_url);
            else reject(error);
        });
        stream.end(buffer);
    });
};

async function transcribeVoiceNote(msg) {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const tempFilePath = path.join(os.tmpdir(), `vn_${Date.now()}.mp3`);
        fs.writeFileSync(tempFilePath, buffer);
        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempFilePath), model: "whisper-1", language: "en" });
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        return transcription.text || "";
    } catch (err) { return ""; }
}

// ----------------------------------------------------
// 2. FLUTTERWAVE VIRTUAL ACCOUNT & BANK LOOKUP ENGINE
// ----------------------------------------------------
async function lookupBankCode(bankNameRaw) {
    try {
        const apiKey = process.env.FLUTTERWAVE_SECRET_KEY;
        if (!apiKey) return null;

        const banksRes = await axios.get('https://api.flutterwave.com/v3/banks/NG', {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 10000
        });

        const banks = banksRes.data?.data;
        if (!banks || !Array.isArray(banks)) return null;

        const bank = banks.find(b => b.name.toLowerCase().includes(bankNameRaw.toLowerCase().trim())) || banks[0];
        return bank ? bank.code : null;
    } catch (error) {
        console.error("⚠️ Flutterwave Bank Code Error (non-fatal):", error?.response?.data || error.message);
        return null;
    }
}

async function createVirtualAccount(customerPhone, amount, productName) {
    try {
        const apiKey = process.env.FLUTTERWAVE_SECRET_KEY;
        if (!apiKey) throw new Error("No Flutterwave API key");

        const ref = `BOT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const response = await axios.post('https://api.flutterwave.com/v3/virtual-account-numbers', {
            email: `buyer_${customerPhone}_${Date.now()}@naxr.com`,
            amount: amount,
            tx_ref: ref,
            is_permanent: false,
            narration: `Naxr - ${productName || 'Order'}`
        }, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        if (response.data && response.data.status === 'success') {
            return {
                accountNumber: response.data.data.account_number,
                bankName: response.data.data.bank_name,
                accountName: response.data.data.account_name || "Naxr Payment",
                txRef: ref,
                isTestMode: apiKey.startsWith('FLWTEST')
            };
        } else {
            throw new Error(response.data.message || "Failed to generate virtual account");
        }
    } catch (error) {
        console.error("⚠️ Flutterwave Virtual Account Error:", error?.response?.data || error.message);
        throw new Error("Failed to create virtual account. Please verify your Flutterwave keys.");
    }
}

// ----------------------------------------------------
// 3. HELPERS & EXTRACTORS
// ----------------------------------------------------
let globalSock = null;
const vendorSockets = {};
const ADMIN_PHONE = process.env.ADMIN_PHONE || "2348148698365";

const botMessageIds = new Set();

async function safeSendMessage(sock, jid, content, options = {}) {
    if (!sock) return null;
    try {
        const sent = await sock.sendMessage(jid, content, options);
        if (sent?.key?.id) {
            botMessageIds.add(sent.key.id);
            if (botMessageIds.size > 3000) {
                const firstKey = botMessageIds.values().next().value;
                botMessageIds.delete(firstKey);
            }
        }
        return sent;
    } catch (err) {
        console.error("❌ safeSendMessage Error:", err.message);
        return null;
    }
}

const REG_TRIGGERS = [
    'i want to register', 'how do i register', 'register my business', 'know more about this ai',
    'hi can i know more', 'register', 'registration', 'sign up', 'signup', 'onboard',
    'create store', 'create account', 'join naxr', 'setup bot', 'set up bot', 'link my whatsapp',
    'tell me about naxr', 'how does this work', 'how to use naxr', 'get started', 'how to register'
];

const CATALOG_TRIGGERS = [
    'catalog', 'catalogue', 'products', 'product list', 'what do you sell', 'show me',
    'can i see the product', 'can i see products', 'can i see product', 'what are the product available',
    'what product available', 'what products are available', 'what products do you have', 'what do you have',
    'what do u have', 'show products', 'send catalog', 'send catalogue', 'send pictures', 'send photos',
    'pictures', 'photos', 'see products', 'view catalog', 'item list', 'list of products', 'all products',
    'available products', 'show catalog', 'show catalogue', 'let me see', 'available items', 'items available',
    'what are your products', 'what do you have available', 'see product', 'view products'
];

const BUYING_INTENT_TRIGGERS = [
    'i want to buy', 'want to buy', 'how to buy', 'can i buy', 'i need', 'i want', 'do you have',
    'do u have', 'whats the price', 'what is the price', "what's the price", 'how much', 'how much is',
    'is this available', 'price', 'price of', 'prices', 'cost', 'cost of', 'catalog', 'catalogue',
    'menu', 'items', 'list', 'products', 'product list', 'show me', 'show products', 'send catalog',
    'send catalogue', 'send pictures', 'send photos', 'pictures', 'photos', 'available', 'buy', 'order',
    'i need to order', 'how to order', 'place order', 'pay for', 'payment', 'how to pay', 'what do you sell',
    'what products do you have', 'what items do you have', 'can i see', 'can i see the product',
    'can i see products', 'let me see', 'show catalog', 'show catalogue', 'stock'
];

function getStepPrompt(step, session = {}) {
    const storeName = session.storeName || "";
    switch (step) {
        case 1: 
            return "📝 *Step 1/8:* What is your Business / Store Name? ✨";
        case 2: 
            return `Store Name saved: *${storeName}* ✅\n\n🏷️ *Step 2/8:* What category is your business?\n\n` +
                   `Reply with one of the numbers below:\n` +
                   `1️⃣ *Retail & Products* (Fashion, Electronics, Food, General Goods)\n` +
                   `2️⃣ *Custom / Bespoke* (Custom Cakes, Tailoring, Handcrafted, Wholesale)\n` +
                   `3️⃣ *Services & Transport* (Campus Shuttle, Taxi, Logistics, Barber, Consultations)`;
        case 3: 
            return "📖 *Step 3/8:* Give a short description of what your business does. 💡";
        case 4:
            if (session.businessType === 'CUSTOM') {
                return "🤝 *Step 4/8:* Do you allow AI price negotiations with buyers?\n\n" +
                       "Reply with *NO* for fixed prices, or reply with the **Max Discount %** allowed (e.g. *15%* to allow up to 15% discount).";
            } else if (session.businessType === 'SERVICE_TRANSPORT') {
                return "💳 *Step 4/8:* How should customers pay for your service/transport?\n\n" +
                       "Reply with:\n" +
                       "1️⃣ *PAY_ON_BOARD* (Students/clients pay cash/transfer upon boarding/service)\n" +
                       "2️⃣ *UPFRONT* (Payment required before booking confirmation)\n" +
                       "3️⃣ *FLEXIBLE* (Both allowed)";
            } else {
                return "📱 *Step 5/8:* Enter your **WhatsApp Phone Number** for linking your AI (e.g., 2348027986674). 📞";
            }
        case 5: 
            return "📱 *Step 5/8:* Enter your **WhatsApp Phone Number** for linking your AI (e.g., 2348027986674). 📞";
        case 6: 
            return "💳 *Step 6/8:* Provide your Bank Name and Account Number (e.g. *Opay - 8148698365*).\n\n" +
                   "_(Note: If your business doesn't collect online payments, reply *SKIP*)._ 🏦";
        case 7: 
            return "🚚 *Step 7/8:* How do you handle delivery/pickup? (e.g. *Same day in Campus*, *Pickup at Garage*, *Nationwide GIGM*). 📦";
        case 8: 
            if (session.businessType === 'SERVICE_TRANSPORT') {
                return "🚕 *Step 8/8:* List your routes or services with prices!\n\n" +
                       "Reply with text like:\n`Main Gate to Hostels - 200`\n`Campus Shuttle Daily Pass - 1000`\n\n" +
                       "Reply *DONE* when finished listing! ✨";
            } else {
                return "📸 *Step 8/8:* Add your products or services!\n\n" +
                       "You can send product photos with captions (e.g. `Vintage Shirt - 12000`), or text only.\n\n" +
                       "When done, reply with *DONE*. ✨";
            }
        default: return "";
    }
}

const extractMessageText = (msg) => {
    if (!msg?.message) return "";
    const m = msg.message;
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.ephemeralMessage?.message) {
        const em = m.ephemeralMessage.message;
        if (em.conversation) return em.conversation;
        if (em.extendedTextMessage?.text) return em.extendedTextMessage.text;
        if (em.imageMessage?.caption) return em.imageMessage.caption;
    }
    return "";
};

function cleanPhoneNumber(rawPhone) {
    if (!rawPhone) return "";
    let basePhone = rawPhone.split('@')[0].split(':')[0];
    let cleaned = basePhone.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) cleaned = '234' + cleaned.substring(1);
    else if (cleaned.length === 10) cleaned = '234' + cleaned;
    return cleaned;
}

// ----------------------------------------------------
// 4. SPAWN DEDICATED VENDOR INSTANCE
// ----------------------------------------------------
async function spawnVendorAgent(realPhone, storeName, requestNewCode = false) {
    const cleanPhone = cleanPhoneNumber(realPhone);
    if (!cleanPhone) return null;

    if (vendorSockets[cleanPhone]) {
        const sock = vendorSockets[cleanPhone];
        if (sock.authState.creds.registered) return "ALREADY_ACTIVE";
        if (requestNewCode) {
            try { return await sock.requestPairingCode(cleanPhone); }
            catch (err) { return "ERROR"; }
        }
        return null;
    }

    const { state, saveCreds } = await useMongoDBAuthState(`vendor_${cleanPhone}`);

    const vendorSock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false,
        browser: ["Mac OS", "Safari", "17.0.0"],
        syncFullHistory: false,
        keepAliveIntervalMs: 30000
    });

    vendorSockets[cleanPhone] = vendorSock;
    vendorSock.ev.on('creds.update', saveCreds);

    let pairingCode = null;
    if (!vendorSock.authState.creds.registered && requestNewCode) {
        await delay(3000);
        try {
            pairingCode = await vendorSock.requestPairingCode(cleanPhone);
            console.log(`\n🔑 VALID VENDOR PAIRING CODE FOR ${storeName} (${cleanPhone}): ${pairingCode}\n`);
        } catch (err) { pairingCode = "ERROR"; }
    } else if (vendorSock.authState.creds.registered) {
        pairingCode = "ALREADY_ACTIVE";
    }

    vendorSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`🚀 Vendor Agent LIVE for ${storeName} (${cleanPhone})!`);
            try {
                const vendorData = await Vendor.findOne({ phoneNumber: cleanPhone });
                if (vendorData && !vendorData.docsSent) {
                    const docsMessage = `🎉 *CONGRATULATIONS! YOUR NAXR AI AGENT IS NOW LIVE!* 🚀\n\n` +
                        `Your 7-Day Free Trial has officially started! Naxr AI is managing sales for *${storeName}*.\n\n` +
                        `🔒 *PRIVACY & SECURITY GUARANTEE*\n` +
                        `Your WhatsApp is completely safe. Naxr AI operates under strict privacy rules. We do NOT read your personal chats. The AI ONLY wakes up when a customer explicitly uses "buying intent" words. Your privacy is 100% protected.\n\n` +
                        `📖 *QUICK OPERATIONAL GUIDE*\n` +
                        `────────────────────────────\n` +
                        `1️⃣ *Automated Catalog:* Customers can ask for your catalog, and the AI will auto-send your product pictures and prices.\n` +
                        `2️⃣ *Virtual Accounts (Anti-Fraud):* Instead of links, Naxr generates a direct **Virtual Bank Account** for every transaction. Fake screenshots won't work anymore—the AI verifies payments instantly via Flutterwave and wires the money to you!\n\n` +
                        `🛠️ *MANAGE YOUR STORE DIRECTLY HERE*\n` +
                        `Message yourself (this chat) with these commands:\n` +
                        `• *stats* - View your total sales.\n` +
                        `• *analytics* - Detailed breakdown of orders & revenue.\n` +
                        `• *products* - See your current list of items.\n` +
                        `• *ai off* / *ai on* - Toggle the AI agent.\n` +
                        `• *edit description [new text]* - Update your business info.\n` +
                        `• *delete product [name]* - Remove an item.\n` +
                        `• *confirm test* - Manually confirm a test payment (test mode only).\n` +
                        `• *Add new item:* Simply send a picture of the product to this chat and write the price and name in the caption!\n\n` +
                        `✨ *You are now ready to scale your business on autopilot!* 🥂`;

                    await vendorSock.sendMessage(`${cleanPhone}@s.whatsapp.net`, { text: docsMessage });
                    vendorData.docsSent = true;
                    await vendorData.save();
                }
            } catch (e) { }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 440 || statusCode === 401 || statusCode === 428 || statusCode === 409) {
                if (vendorSockets[cleanPhone]) {
                    vendorSockets[cleanPhone].ev.removeAllListeners('creds.update');
                    vendorSockets[cleanPhone].ev.removeAllListeners('connection.update');
                    delete vendorSockets[cleanPhone];
                }
                await Auth.deleteMany({ _id: { $regex: `^vendor_${cleanPhone}` } });
                return;
            }
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            delete vendorSockets[cleanPhone];
            if (shouldReconnect) setTimeout(() => spawnVendorAgent(cleanPhone, storeName, false), statusCode === 515 ? 1000 : 5000);
        }
    });

    vendorSock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages) {
            try {
                if (!msg.message) continue;

                // Skip messages sent by our bot itself
                if (msg.key.id && botMessageIds.has(msg.key.id)) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

                const isImage = !!(msg.message.imageMessage || msg.message.ephemeralMessage?.message?.imageMessage);
                const isAudio = !!(msg.message.audioMessage || msg.message.ephemeralMessage?.message?.audioMessage);
                let textMessage = extractMessageText(msg);

                if (isAudio) {
                    textMessage = await transcribeVoiceNote(msg);
                    if (!textMessage || textMessage.trim().length < 3) continue;
                }
                if (!textMessage && !isImage) continue;

                const lowerText = textMessage ? textMessage.toLowerCase().trim() : "";
                const cleanRemoteJidNumber = cleanPhoneNumber(remoteJid);
                const cleanVendorPhone = cleanPhone;

                const isVendorSelfChat = cleanRemoteJidNumber === cleanVendorPhone ||
                    remoteJid.includes(cleanVendorPhone) ||
                    remoteJid.endsWith('@lid') ||
                    msg.key.fromMe;

                const vendorData = await Vendor.findOne({ phoneNumber: cleanVendorPhone });

                // Check for explicit vendor self commands
                const VENDOR_COMMAND_KEYWORDS = ['stats', 'sales', 'dashboard', 'analytics', 'products', 'catalog', 'ai off', 'ai on', 'help', 'confirm test', 'test confirm'];
                const isVendorCommand = VENDOR_COMMAND_KEYWORDS.some(cmd => lowerText === cmd || lowerText.startsWith('edit description ') || lowerText.startsWith('delete product '));

                // Only handle in vendor self admin flow if it's a text command, OR an image intended as an admin action (contains pricing information in the caption to add product)
                const isProductAddImage = isImage && textMessage && textMessage.match(/\d+/);
                
                if (isVendorSelfChat && (isVendorCommand || isProductAddImage)) {
                    if (vendorData) {
                        const daysActive = (Date.now() - new Date(vendorData.createdAt).getTime()) / (1000 * 60 * 60 * 24);
                        if (daysActive > 7 && !vendorData.isPro) {
                            const trialExpiredMessage = `⚠️ *TRIAL EXPIRED:* Your 7-day Naxr AI trial has ended. Your bot is currently paused.\n\n` +
                                `To renew your subscription and keep automated sales running, please make payment to:\n\n` +
                                `🏦 *Bank:* Kuda Microfinance Bank\n` +
                                `🔢 *Account Number:* 3003853004\n` +
                                `👤 *Account Name:* KUKA TECHNOLOGY AND INNOVATION LIMITED\n\n` +
                                `👉 *After payment, simply send the transaction receipt screenshot to this chat.* Our system will verify the receipt and automatically reactivate your service! 🚀`;
                            await safeSendMessage(vendorSock, remoteJid, { text: trialExpiredMessage });
                            continue;
                        }
                    }

                    // ─── VENDOR SELF-CHAT ADMIN CONTROLS ───
                    if (lowerText === 'ai off') {
                        await Vendor.findOneAndUpdate({ phoneNumber: cleanVendorPhone }, { aiActive: false });
                        await safeSendMessage(vendorSock, remoteJid, { text: `🛑 *AI Agent is now OFF.*\n\nCustomers will no longer receive automated replies until you turn it back on.` });
                        continue;
                    }
                    if (lowerText === 'ai on') {
                        await Vendor.findOneAndUpdate({ phoneNumber: cleanVendorPhone }, { aiActive: true });
                        await safeSendMessage(vendorSock, remoteJid, { text: `✅ *AI Agent is now ON.*\n\nYour store is live and ready to take orders!` });
                        continue;
                    }

                    // STATS
                    if (lowerText === 'stats' || lowerText === 'sales' || lowerText === 'dashboard') {
                        const salesCount = await Order.countDocuments({ vendorPhone: cleanVendorPhone, status: 'PAID' });
                        const pendingCount = await Order.countDocuments({ vendorPhone: cleanVendorPhone, status: 'PENDING' });
                        const productsCount = await Product.countDocuments({ vendorPhone: cleanVendorPhone });
                        const totalRevenue = await Order.aggregate([
                            { $match: { vendorPhone: cleanVendorPhone, status: 'PAID' } },
                            { $group: { _id: null, total: { $sum: '$amount' } } }
                        ]);
                        const revenue = totalRevenue[0]?.total || 0;

                        let trialText = vendorData?.isPro ? "✅ Pro Plan Active" : `⏳ Free Trial: ${Math.max(7 - Math.floor((Date.now() - new Date(vendorData.createdAt).getTime()) / (1000 * 60 * 60 * 24)), 0)} days left`;
                        let aiStatus = vendorData?.aiActive !== false ? "🟢 AI ON" : "🔴 AI OFF";

                        await safeSendMessage(vendorSock, remoteJid, {
                            text: `📊 *${storeName} Admin Dashboard*\n\n` +
                                `🛍️ Active Products: ${productsCount}\n` +
                                `✅ Confirmed Paid Sales: ${salesCount}\n` +
                                `⏳ Pending Orders: ${pendingCount}\n` +
                                `💰 Total Revenue: ₦${revenue.toLocaleString()}\n\n` +
                                `${trialText}\n${aiStatus}`
                        });
                        continue;
                    }

                    // ANALYTICS (enhanced stats)
                    if (lowerText === 'analytics') {
                        const paidOrders = await Order.find({ vendorPhone: cleanVendorPhone, status: 'PAID' }).sort({ createdAt: -1 }).limit(5);
                        const pendingOrders = await Order.find({ vendorPhone: cleanVendorPhone, status: 'PENDING' }).sort({ createdAt: -1 }).limit(5);
                        const totalRevenue = await Order.aggregate([
                            { $match: { vendorPhone: cleanVendorPhone, status: 'PAID' } },
                            { $group: { _id: null, total: { $sum: '$amount' } } }
                        ]);
                        const revenue = totalRevenue[0]?.total || 0;

                        const recentPaid = paidOrders.length > 0
                            ? paidOrders.map(o => `• ${o.productName} — ₦${o.amount.toLocaleString()} (+${o.customerPhone})`).join('\n')
                            : "No paid orders yet.";

                        const recentPending = pendingOrders.length > 0
                            ? pendingOrders.map(o => `• ${o.productName} — ₦${o.amount.toLocaleString()} (Ref: ${o.virtualAccountNumber})`).join('\n')
                            : "No pending orders.";

                        await safeSendMessage(vendorSock, remoteJid, {
                            text: `📈 *Analytics for ${storeName}*\n\n` +
                                `*Revenue:* ₦${revenue.toLocaleString()}\n\n` +
                                `*Recent Paid Orders:*\n${recentPaid}\n\n` +
                                `*Pending Orders:*\n${recentPending}\n\n` +
                                `_Reply 'stats' for a quick summary._`
                        });
                        continue;
                    }

                    // PRODUCTS
                    if (lowerText === 'products' || lowerText === 'catalog') {
                        const activeProducts = await Product.find({ vendorPhone: cleanVendorPhone });
                        if (activeProducts.length > 0) {
                            await safeSendMessage(vendorSock, remoteJid, { text: `📦 *Product Catalog for ${storeName}:*` });
                            for (const p of activeProducts) {
                                if (p.imageUrl) {
                                    try {
                                        await safeSendMessage(vendorSock, remoteJid, {
                                            image: { url: p.imageUrl },
                                            caption: `🛍️ *${p.name}*\n💰 Price: ₦${p.price.toLocaleString()}`
                                        });
                                    } catch (e) {
                                        await safeSendMessage(vendorSock, remoteJid, { text: `🛍️ *${p.name}*\n💰 Price: ₦${p.price.toLocaleString()}` });
                                    }
                                } else {
                                    await safeSendMessage(vendorSock, remoteJid, { text: `🛍️ *${p.name}*\n💰 Price: ₦${p.price.toLocaleString()}` });
                                }
                            }
                        } else {
                            await safeSendMessage(vendorSock, remoteJid, { text: `📦 No products added yet.` });
                        }
                        continue;
                    }

                    // EDIT DESCRIPTION
                    if (lowerText.startsWith('edit description ')) {
                        const newDesc = textMessage.substring(17).trim();
                        await Vendor.updateOne({ phoneNumber: cleanVendorPhone }, { description: newDesc });
                        await safeSendMessage(vendorSock, remoteJid, { text: `✅ Business description updated.` });
                        continue;
                    }

                    // DELETE PRODUCT
                    if (lowerText.startsWith('delete product ')) {
                        const prodName = textMessage.substring(15).trim();
                        const res = await Product.deleteOne({ vendorPhone: cleanVendorPhone, name: { $regex: new RegExp(prodName, 'i') } });
                        if (res.deletedCount > 0) await safeSendMessage(vendorSock, remoteJid, { text: `✅ Product "${prodName}" deleted.` });
                        else await safeSendMessage(vendorSock, remoteJid, { text: `⚠️ Product not found.` });
                        continue;
                    }

                    // CONFIRM TEST PAYMENT
                    if (lowerText === 'confirm test' || lowerText === 'test confirm') {
                        const pendingOrder = await Order.findOne({ vendorPhone: cleanVendorPhone, status: 'PENDING' }).sort({ createdAt: -1 });
                        if (!pendingOrder) {
                            await safeSendMessage(vendorSock, remoteJid, { text: `⚠️ No pending orders found.` });
                            continue;
                        }
                        pendingOrder.status = 'PAID';
                        await pendingOrder.save();

                        await safeSendMessage(vendorSock, `${pendingOrder.customerPhone}@s.whatsapp.net`, {
                            text: `✅ *PAYMENT CONFIRMED!*\n\nYour order for *${pendingOrder.productName}* has been confirmed. 🎉`
                        });
                        await safeSendMessage(vendorSock, remoteJid, {
                            text: `✅ *Order confirmed!*\n\nItem: ${pendingOrder.productName}\nAmount: ₦${pendingOrder.amount.toLocaleString()}\nCustomer: +${pendingOrder.customerPhone}`
                        });
                        continue;
                    }

                    // ADD PRODUCT OR SUSCRIPTION RECEIPT CHECK
                    if (isImage) {
                        const match = textMessage.match(/\d+/);
                        if (match) {
                            // Vendor adding new item
                            const price = parseInt(match[0]);
                            const name = textMessage.replace(match[0], '').replace(/[#₦$-]/g, '').trim() || "Unnamed Item";
                            await safeSendMessage(vendorSock, remoteJid, { react: { text: "⏳", key: msg.key } });
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            const imageUrl = await uploadToCloudinary(buffer);
                            await Product.create({ vendorPhone: cleanVendorPhone, name, price, imageUrl });
                            await safeSendMessage(vendorSock, remoteJid, { text: `✅ *New Product Added!*\n\n${name} - ₦${price.toLocaleString()}` });
                        } else {
                            // Evaluate as a subscription receipt upload
                            try {
                                await safeSendMessage(vendorSock, remoteJid, { react: { text: "⏳", key: msg.key } });
                                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                                const base64Image = buffer.toString('base64');

                                const visionResponse = await openai.chat.completions.create({
                                    model: "gpt-4o-mini",
                                    messages: [
                                        {
                                            role: "user",
                                            content: [
                                                { 
                                                    type: "text", 
                                                    text: `Analyze this image strictly for payment verification.
Determine if this is a transfer receipt or proof of payment:
1. Is it a transfer to:
   - Account: 3003853004
   - Bank: Kuda Microfinance Bank
   - Account Name: KUKA TECHNOLOGY AND INNOVATION LIMITED
2. Does it look authentic without pixelation anomalies, editing artifacts, mismatches, or digital manipulation?

Reply in JSON format only: {"isSubscriptionReceipt": true/false, "isSuspicious": true/false, "confidence": "high/medium/low", "reason": "Explain details."}` 
                                                },
                                                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                                            ]
                                        }
                                    ],
                                    response_format: { type: "json_object" }
                                });

                                const analysis = JSON.parse(visionResponse.choices[0].message.content.trim());
                                if (analysis.isSubscriptionReceipt && !analysis.isSuspicious) {
                                    await Vendor.findOneAndUpdate({ phoneNumber: cleanVendorPhone }, { isPro: true });
                                    await safeSendMessage(vendorSock, remoteJid, { react: { text: "✅", key: msg.key } });
                                    await safeSendMessage(vendorSock, remoteJid, { 
                                        text: `🎉 *PAYMENT VERIFIED SUCCESSFULLY!*\n\nThank you! Your Naxr AI Pro Subscription has been activated. Your store is now active and automating sales again! 🚀` 
                                    });

                                    // Notify Admin of new activation
                                    if (globalSock) {
                                        await safeSendMessage(globalSock, `${ADMIN_PHONE}@s.whatsapp.net`, {
                                            text: `👑 *NEW SUBSCRIPTION ACTIVATED!*\n\nVendor: ${storeName} (${cleanVendorPhone})\nReceipt Status: Verified by AI (${analysis.confidence} confidence).\nReason: ${analysis.reason}`
                                        });
                                        await safeSendMessage(globalSock, `${ADMIN_PHONE}@s.whatsapp.net`, {
                                            image: buffer,
                                            caption: `📄 Subscription Receipt for ${storeName} (${cleanVendorPhone})`
                                        });
                                    }
                                } else {
                                    await safeSendMessage(vendorSock, remoteJid, { react: { text: "❌", key: msg.key } });
                                    await safeSendMessage(vendorSock, remoteJid, { 
                                        text: `⚠️ *RECEIPT VERIFICATION FAILED:*\n\nReason: ${analysis.reason}\n\nIf you believe this is an error, please contact support for manual activation.` 
                                    });
                                    
                                    // Alert admin of failed receipt upload
                                    if (globalSock) {
                                        await safeSendMessage(globalSock, `${ADMIN_PHONE}@s.whatsapp.net`, {
                                            text: `⚠️ *FAILED/SUSPICIOUS SUBSCRIPTION RECEIPT DETECTED!*\n\nVendor: ${storeName} (${cleanVendorPhone})\nAI Review: ${analysis.reason}`
                                        });
                                        await safeSendMessage(globalSock, `${ADMIN_PHONE}@s.whatsapp.net`, {
                                            image: buffer,
                                            caption: `📄 Failed Subscription Receipt for ${storeName} (${cleanVendorPhone})`
                                        });
                                    }
                                }
                            } catch (err) {
                                await safeSendMessage(vendorSock, remoteJid, { text: `⚠️ Could not verify receipt at this time: ${err.message}` });
                            }
                        }
                        continue;
                    }

                    // HELP
                    if (lowerText === 'help') {
                        await safeSendMessage(vendorSock, remoteJid, {
                            text: `💡 *Naxr Vendor Commands:*\n` +
                                `• *stats* — Quick sales summary\n` +
                                `• *analytics* — Detailed breakdown\n` +
                                `• *products* — View catalog\n` +
                                `• *ai on* / *ai off* — Toggle AI\n` +
                                `• *edit description [text]*\n` +
                                `• *delete product [name]*\n` +
                                `• *confirm test* — Confirm pending order\n` +
                                `• Send image + price to add product`
                        });
                        continue;
                    }

                    // If vendor self-chat message matched command/image, we continue
                    continue;
                }

                // ─── CUSTOMER-FACING AI ───
                if (msg.key.fromMe) continue;
                if (!vendorData || vendorData.aiActive === false) continue;

                const activeProducts = await Product.find({ vendorPhone: cleanVendorPhone });

                // Check paid command or receipt image from customer
                const isReceiptText = ['paid', 'i have paid', 'i paid', 'payment sent', 'done paying', 'done', 'transfer done', 'sent', 'receipt', 'proof'].includes(lowerText) || lowerText.includes('screenshot') || lowerText.includes('receipt') || lowerText.includes('proof');
                const pendingOrder = await Order.findOne({ vendorPhone: cleanVendorPhone, customerPhone: cleanRemoteJidNumber, status: 'PENDING' }).sort({ createdAt: -1 });

                if (pendingOrder && (isImage || isReceiptText)) {
                    let receiptVerificationInfo = "No receipt image attached.";
                    let isVisionFlaggedSuspicious = false;

                    if (isImage) {
                        try {
                            await safeSendMessage(vendorSock, remoteJid, { react: { text: "⏳", key: msg.key } });
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            const base64Image = buffer.toString('base64');

                            const todayDateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

                            const visionResponse = await openai.chat.completions.create({
                                model: "gpt-4o-mini",
                                messages: [
                                    {
                                        role: "user",
                                        content: [
                                            { 
                                                type: "text", 
                                                text: `Analyze this image strictly for payment fraud. Today's date is ${todayDateStr}. Look closely at the receipt details:
1. Is this a valid transfer receipt/proof of payment?
2. Does the amount shown on the receipt match ₦${pendingOrder.amount} exactly?
3. Check for signs of digital manipulation (e.g. font mismatches, pixelation around numbers, weird spacing, alignment issues or known fake receipt generator templates).
4. Is the date/timestamp matching today (${todayDateStr}) or reasonable recent past? (Do not flag today's date as being in the future).

Reply in JSON format only: {"isReceipt": true/false, "isSuspicious": true/false, "confidence": "high/medium/low", "reason": "Explain details of what you found."}` 
                                            },
                                            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                                        ]
                                    }
                                ],
                                response_format: { type: "json_object" }
                            });

                            const analysis = JSON.parse(visionResponse.choices[0].message.content.trim());
                            if (analysis.isReceipt && !analysis.isSuspicious) {
                                receiptVerificationInfo = `Verified receipt with ${analysis.confidence} confidence. Reason: ${analysis.reason}`;
                                await safeSendMessage(vendorSock, remoteJid, { react: { text: "✅", key: msg.key } });
                            } else {
                                isVisionFlaggedSuspicious = true;
                                receiptVerificationInfo = `🚨 SUSPICIOUS/FLAGGED: ${analysis.reason}`;
                                await safeSendMessage(vendorSock, remoteJid, { react: { text: "⚠️", key: msg.key } });
                            }
                        } catch (err) {
                            receiptVerificationInfo = `Could not analyze image: ${err.message}`;
                        }
                    }

                    // Generate a confirmation receipt response
                    const receiptNumber = `REC-${Date.now().toString().slice(-6)}`;
                    const receiptText = `🧾 *NAXR TRANSACTION RECEIPT*\n` +
                        `────────────────────────────\n` +
                        `Receipt No: *${receiptNumber}*\n` +
                        `Product: *${pendingOrder.productName}*\n` +
                        `Amount: *₦${pendingOrder.amount.toLocaleString()}*\n` +
                        `Customer: *+${cleanRemoteJidNumber}*\n` +
                        `Status: *AWAITING SELLER CONFIRMATION*\n` +
                        `────────────────────────────\n\n` +
                        `⚠️ *Please Note:* This receipt is an automated proof that you submitted your payment. It does *NOT* mean your order is automatically confirmed. The vendor must manually verify the transfer in their bank app before shipping. Thank you for your patience! 🙏`;

                    await safeSendMessage(vendorSock, remoteJid, { text: receiptText });

                    // Send alert details to vendor
                    const vendorAlertMessage = isVisionFlaggedSuspicious 
                        ? `🚨 *POSSIBLE FAKE RECEIPT DETECTED!*\n\n` +
                          `Customer +${cleanRemoteJidNumber} sent a suspicious receipt for *${pendingOrder.productName}* (₦${pendingOrder.amount.toLocaleString()}).\n\n` +
                          `⚠️ *AI Fraud Check:* ${receiptVerificationInfo}\n\n` +
                          `👉 *Do NOT deliver* until you verify this transfer inside your bank app. If valid, reply *"confirm test"* to confirm payment.`
                        : `📩 *CUSTOMER SUBMITTED PAYMENT RECEIPT!*\n\n` +
                          `Order: *${pendingOrder.productName}* (₦${pendingOrder.amount.toLocaleString()})\n` +
                          `Customer: +${cleanRemoteJidNumber}\n\n` +
                          `🔍 *AI Verification Check:* ${receiptVerificationInfo}\n\n` +
                          `👉 Please confirm your bank app and reply with *"confirm test"* to confirm payment.`;

                    await safeSendMessage(vendorSock, `${cleanVendorPhone}@s.whatsapp.net`, { text: vendorAlertMessage });

                    if (isImage) {
                        // Forward receipt image to vendor
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        await safeSendMessage(vendorSock, `${cleanVendorPhone}@s.whatsapp.net`, {
                            image: buffer,
                            caption: `📄 Receipt proof sent by customer +${cleanRemoteJidNumber}`
                        });
                    }
                    continue;
                }

                let hasBuyingIntent = BUYING_INTENT_TRIGGERS.some(trigger => {
                    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`(?:^|[\\s.,!?;:\\-])${escaped}(?:[\\s.,!?;:\\-]|$)`, 'i');
                    return regex.test(lowerText);
                });

                if (!hasBuyingIntent && activeProducts.length > 0) {
                    hasBuyingIntent = activeProducts.some(p => {
                        const cleanName = p.name.replace(/[^\w\s]/gi, '').toLowerCase().trim();
                        if (cleanName.length < 3) return false;
                        const regex = new RegExp(`(?:^|[\\s.,!?;:\\-])${cleanName}(?:[\\s.,!?;:\\-]|$)`, 'i');
                        return regex.test(lowerText);
                    });
                }

                if (isAudio && !hasBuyingIntent) continue;
                if (!hasBuyingIntent) continue;

                const isCatalogRequest = CATALOG_TRIGGERS.some(t => lowerText.includes(t));

                if (isCatalogRequest) {
                    if (activeProducts.length > 0) {
                        await safeSendMessage(vendorSock, remoteJid, { text: `📦 *Here is our current catalog for ${storeName}:*` });
                        for (const p of activeProducts) {
                            if (p.imageUrl) {
                                try {
                                    await safeSendMessage(vendorSock, remoteJid, {
                                        image: { url: p.imageUrl },
                                        caption: `🛍️ *${p.name}*\n💰 *Price:* ₦${p.price.toLocaleString()}\n\n👉 Reply *"I want to buy ${p.name}"* to place an order!`
                                    });
                                } catch (e) {
                                    await safeSendMessage(vendorSock, remoteJid, {
                                        text: `🛍️ *${p.name}*\n💰 *Price:* ₦${p.price.toLocaleString()}\n\n👉 Reply *"I want to buy ${p.name}"* to place an order!`
                                    });
                                }
                            } else {
                                await safeSendMessage(vendorSock, remoteJid, {
                                    text: `🛍️ *${p.name}*\n💰 *Price:* ₦${p.price.toLocaleString()}\n\n👉 Reply *"I want to buy ${p.name}"* to place an order!`
                                });
                            }
                        }
                        await delay(1000);
                        await safeSendMessage(vendorSock, remoteJid, { text: `✨ Reply with the name of any item you'd like to buy!` });
                    } else {
                        await safeSendMessage(vendorSock, remoteJid, { text: `📦 We are currently updating our catalog.` });
                    }
                    continue;
                }

                const todayDateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
                const catalog = activeProducts.map(p => {
                    const minStr = (p.isNegotiable && p.minPrice > 0) ? ` (Listed: ₦${p.price}, Minimum allowed price: ₦${p.minPrice})` : ` (Price: ₦${p.price})`;
                    return `- ${p.name}${minStr}`;
                }).join("\n");

                const businessType = vendorData.businessType || 'RETAIL';
                const paymentPolicy = vendorData.paymentPolicy || 'UPFRONT';
                const allowNegotiation = vendorData.allowNegotiation || false;

                const negotiationInstructions = allowNegotiation
                    ? `You are allowed to negotiate prices WITH BOUNDS. You must NEVER accept or output a price lower than the 'Minimum allowed price' specified for that item. If customer offers below the minimum, politely counter-offer with the minimum price.`
                    : `Prices are FIXED. Do NOT offer or accept any discounts or reduced prices.`;

                const policyInstructions = (paymentPolicy === 'PAY_ON_BOARD' || businessType === 'SERVICE_TRANSPORT')
                    ? `This business operates on PAY ON BOARD / PAY AT SERVICE. Payment is NOT required upfront.`
                    : `Payment is required UPFRONT to confirm order.`;

                const customerAI = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content: `You are Naxr, sales & booking rep for ${storeName} (${vendorData.category || 'Business'}). Today's date is ${todayDateStr}.
Business Description: ${vendorData.description || 'N/A'}
Delivery/Service Info: ${vendorData.deliveryInfo || 'N/A'}

Catalog / Services:
${catalog}

Rules:
1. ${negotiationInstructions}
2. ${policyInstructions}
3. If customer explicitly agrees/wants to buy, book, or reserve a specific item/service, output JSON ONLY: {"action": "BUY", "productName": "Exact Name", "price": agreed_number_price}.
4. Otherwise reply naturally, helpfully, and concisely with friendly emojis.`
                        },
                        { role: "user", content: textMessage }
                    ]
                });

                const reply = customerAI.choices[0].message.content.trim();

                if (reply.startsWith('{') && reply.endsWith('}')) {
                    try {
                        const data = JSON.parse(reply);

                        const orderRefNumber = `NX-${Date.now().toString().slice(-6)}`;
                        const vendorBank = vendorData.bankDetails || "Vendor Direct Account";
                        const isPayOnBoard = (paymentPolicy === 'PAY_ON_BOARD' || businessType === 'SERVICE_TRANSPORT');

                        await Order.create({
                            vendorPhone: cleanVendorPhone,
                            customerPhone: cleanRemoteJidNumber,
                            productName: data.productName,
                            amount: data.price,
                            paymentPolicy: paymentPolicy,
                            virtualAccountNumber: orderRefNumber,
                            status: isPayOnBoard ? 'BOOKED' : 'PENDING'
                        });

                        if (isPayOnBoard) {
                            await safeSendMessage(vendorSock, remoteJid, {
                                text: `🚌 *Booking Confirmed: ${data.productName}*\n\n` +
                                    `💰 *Fare / Price:* ₦${data.price.toLocaleString()}\n` +
                                    `Ref Code: *${orderRefNumber}*\n` +
                                    `💳 *Payment Policy:* Pay cash/transfer upon boarding or service delivery. ✨\n\n` +
                                    `Thank you for booking with *${storeName}*! See you soon! 🙌`
                            });
                            // Notify vendor
                            await safeSendMessage(vendorSock, `${cleanVendorPhone}@s.whatsapp.net`, {
                                text: `🔔 *NEW SERVICE BOOKING!*\n\nService/Route: ${data.productName}\nFare: ₦${data.price.toLocaleString()}\nCustomer: +${cleanRemoteJidNumber}\nPayment Mode: Pay on Boarding/Delivery`
                            });
                        } else {
                            await safeSendMessage(vendorSock, remoteJid, {
                                text: `🛍️ *Order Initiated: ${data.productName}*\n\n` +
                                    `💰 *Amount Due:* ₦${data.price.toLocaleString()}\n\n` +
                                    `🏦 *Payment Account Details:*\n` +
                                    `Bank & Account: *${vendorBank}*\n` +
                                    `Order Ref: *${orderRefNumber}*\n\n` +
                                    `👉 Please make payment to the account above and reply by sending *PAID* or sharing your receipt! ✨\n` +
                                    `*(Note: The vendor will verify your transfer and confirm your order).*`
                            });
                        }
                    } catch (e) {
                        console.error("❌ Checkout Processing Error:", e.message, e.stack);
                        await safeSendMessage(vendorSock, remoteJid, { text: "⚠️ Could not initiate order details at this time." });
                    }
                } else {
                    await safeSendMessage(vendorSock, remoteJid, { text: reply });

                    const matchedProduct = activeProducts.find(p => {
                        const cleanName = p.name.replace(/[^\w\s]/gi, '').toLowerCase().trim();
                        return cleanName.length >= 3 && lowerText.includes(cleanName);
                    });

                    if (matchedProduct && matchedProduct.imageUrl) {
                        try {
                            await safeSendMessage(vendorSock, remoteJid, {
                                image: { url: matchedProduct.imageUrl },
                                caption: `🛍️ *${matchedProduct.name}*\n💰 *Price:* ₦${matchedProduct.price.toLocaleString()}`
                            });
                        } catch (e) { }
                    }
                }
            } catch (error) {
                console.error(`❌ Message Processing Error for ${msg?.key?.remoteJid}:`, error);
            }
        }
    });

    return pairingCode;
}

// ----------------------------------------------------
// 5. MASTER ONBOARDING AGENT SOCKET
// ----------------------------------------------------
async function startNaxrMasterAgent(isReconnect = false) {
    const { state, saveCreds } = await useMongoDBAuthState('master_agent_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false,
        browser: ["Mac OS", "Safari", "17.0.0"],
        syncFullHistory: false,
        keepAliveIntervalMs: 30000
    });

    globalSock = sock;
    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered && !isReconnect) {
        await delay(4000);
        const myNumber = cleanPhoneNumber(ADMIN_PHONE);
        try {
            const code = await sock.requestPairingCode(myNumber);
            console.log(`\n======================================`);
            console.log(`🔑 NAXR MASTER PAIRING CODE: ${code}`);
            console.log(`======================================\n`);
        } catch (err) { }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log("🚀 NAXR MASTER ONBOARDING AGENT IS LIVE! 🇳🇬");
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 440 || statusCode === 409) return;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => startNaxrMasterAgent(true), statusCode === 515 ? 1000 : 5000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages) {
            try {
                if (!msg.message) continue;
                if (msg.key.id && botMessageIds.has(msg.key.id)) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

                const isImage = !!(msg.message.imageMessage || msg.message.ephemeralMessage?.message?.imageMessage);
                let textMessage = extractMessageText(msg);

                const lowerText = textMessage ? textMessage.toLowerCase().trim() : "";
                const cleanText = lowerText.replace(/[^\w\s]/gi, '').trim();
                const cleanRemoteJidNumber = cleanPhoneNumber(remoteJid);
                const cleanAdminPhone = cleanPhoneNumber(ADMIN_PHONE);

                const isAdminMessage = cleanRemoteJidNumber === cleanAdminPhone || remoteJid.includes(cleanAdminPhone) || msg.key.fromMe;

                if (isAdminMessage) {
                    if (lowerText === 'admin stats' || lowerText === 'stats') {
                        const totalVendors = await Vendor.countDocuments({});
                        const totalOrders = await Order.countDocuments({ status: 'PAID' });
                        const totalProducts = await Product.countDocuments({});
                        await safeSendMessage(sock, remoteJid, { text: `👑 *Naxr Super Admin*\n\n👥 Total Vendors: ${totalVendors}\n🛍️ Total Products Listed: ${totalProducts}\n✅ Total Paid Orders: ${totalOrders}` });
                        continue;
                    }
                    if (lowerText === 'admin vendors' || lowerText === 'vendors') {
                        const vendors = await Vendor.find({});
                        const vList = vendors.map(v => `• ${v.storeName} (${v.phoneNumber})`).join("\n");
                        await safeSendMessage(sock, remoteJid, { text: `👑 *Registered Vendors:*\n\n${vList || "No vendors yet."}` });
                        continue;
                    }
                    if (lowerText.startsWith('delete vendor ')) {
                        const targetPhone = cleanPhoneNumber(lowerText.replace('delete vendor', '').trim());
                        await Vendor.deleteOne({ phoneNumber: targetPhone });
                        await Product.deleteMany({ vendorPhone: targetPhone });

                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update');
                            try { vendorSockets[targetPhone].ws.close(); } catch (e) { }
                            delete vendorSockets[targetPhone];
                        }
                        await Auth.deleteMany({ _id: { $regex: `^vendor_${targetPhone}` } });
                        await safeSendMessage(sock, remoteJid, { text: `✅ Vendor ${targetPhone} completely purged from system.` });
                        continue;
                    }
                    if (lowerText.startsWith('activate vendor ')) {
                        const targetPhone = cleanPhoneNumber(lowerText.replace('activate vendor', '').trim());
                        const v = await Vendor.findOneAndUpdate({ phoneNumber: targetPhone }, { isPro: true }, { new: true });
                        if (v) {
                            await safeSendMessage(sock, remoteJid, { text: `✅ Vendor *${v.storeName}* (${targetPhone}) is now set to **Pro/Active**!` });
                        } else {
                            await safeSendMessage(sock, remoteJid, { text: `⚠️ Vendor with phone number ${targetPhone} not found.` });
                        }
                        continue;
                    }
                    if (lowerText.startsWith('cancel vendor ')) {
                        const targetPhone = cleanPhoneNumber(lowerText.replace('cancel vendor', '').trim());
                        const v = await Vendor.findOneAndUpdate({ phoneNumber: targetPhone }, { isPro: false }, { new: true });
                        if (v) {
                            await safeSendMessage(sock, remoteJid, { text: `🛑 Vendor *${v.storeName}* (${targetPhone}) subscription canceled. Reverted to standard trial tier.` });
                        } else {
                            await safeSendMessage(sock, remoteJid, { text: `⚠️ Vendor with phone number ${targetPhone} not found.` });
                        }
                        continue;
                    }
                }

                if (msg.key.fromMe) continue;

                if (cleanText === 'reset' || cleanText === 'restart') {
                    const existingVendorForReset = await Vendor.findOne({ jid: remoteJid });

                    if (existingVendorForReset) {
                        const targetPhone = cleanPhoneNumber(existingVendorForReset.phoneNumber);

                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('creds.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('messages.upsert');
                            try { vendorSockets[targetPhone].ws.close(); } catch (e) { }
                            delete vendorSockets[targetPhone];
                        }

                        await Auth.deleteMany({ _id: { $regex: `^vendor_${targetPhone}` } });
                        await Vendor.deleteOne({ jid: remoteJid });
                    }

                    await RegSession.deleteOne({ phoneNumber: remoteJid });
                    const newSession = await RegSession.create({ phoneNumber: remoteJid, step: 1, products: [] });

                    await sock.sendMessage(remoteJid, { text: `🔄 *Progress Reset!*\n\nOld store data cleared. Let's start over.\n\n` + getStepPrompt(1) });
                    continue;
                }

                const existingVendor = await Vendor.findOne({ jid: remoteJid });
                const isRegTrigger = REG_TRIGGERS.some(t => {
                    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`(?:^|[\\s.,!?;:\\-])${escaped}(?:[\\s.,!?;:\\-]|$)`, 'i');
                    return regex.test(lowerText);
                });

                if (existingVendor) {
                    if (cleanText === 'link' || cleanText === 'code' || cleanText === 'relink' || cleanText === 'new code') {
                        const targetPhone = cleanPhoneNumber(existingVendor.phoneNumber);
                        if (targetPhone !== existingVendor.phoneNumber) { existingVendor.phoneNumber = targetPhone; await existingVendor.save(); }

                        await sock.sendMessage(remoteJid, { text: `🔄 Generating a fresh pairing code for *${existingVendor.storeName}*...` });

                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('creds.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('messages.upsert');
                            try { vendorSockets[targetPhone].ws.close(); } catch (e) { }
                            delete vendorSockets[targetPhone];
                            await delay(1500);
                        }
                        await Auth.deleteMany({ _id: { $regex: `^vendor_${targetPhone}` } });

                        const newCode = await spawnVendorAgent(targetPhone, existingVendor.storeName, true);

                        if (newCode && newCode !== "ALREADY_ACTIVE" && newCode !== "ERROR") {
                            await sock.sendMessage(remoteJid, {
                                text: `🔑 *YOUR VENDOR AI PAIRING CODE:* \`${newCode}\`\n\n🛡️ *Note:* Because Naxr is an automated AI, WhatsApp may show a security warning asking if you know who is linking the device. Tap *"Continue"* to authorize your bot.\n\n1. Go to WhatsApp Settings > Linked Devices > Link a Device.\n2. Tap Link with phone number instead.\n3. Enter the code above.`
                            });
                        } else if (newCode === "ALREADY_ACTIVE") await sock.sendMessage(remoteJid, { text: `✅ Your AI is already connected and active!` });
                        else await sock.sendMessage(remoteJid, { text: `⚠️ Network delay. Please reply with *LINK* again in 5 seconds.` });
                    } else if (cleanText === 'done') {
                        const targetPhone = cleanPhoneNumber(existingVendor.phoneNumber);
                        const vSock = vendorSockets[targetPhone];
                        if (vSock && vSock.authState.creds.registered) await sock.sendMessage(remoteJid, { text: `✅ Your store *${existingVendor.storeName}* is already active!` });
                        else await sock.sendMessage(remoteJid, { text: `⚠️ Your store is registered but not connected right now. Reply with *LINK* to get a new code!` });
                    } else if (isRegTrigger) await sock.sendMessage(remoteJid, { text: `⚠️ Store *${existingVendor.storeName}* is registered. Reply with *LINK* to get a new pairing code!` });
                    continue;
                }

                let session = await RegSession.findOne({ phoneNumber: remoteJid });

                if (isRegTrigger) {
                    if (!session) {
                        session = await RegSession.create({ phoneNumber: remoteJid, step: 1, products: [] });
                        await sock.sendMessage(remoteJid, { text: `👋 Welcome to *Naxr*!\n\n` + getStepPrompt(1) });
                    } else await sock.sendMessage(remoteJid, { text: `🔄 *Resuming Onboarding*\n\n` + getStepPrompt(session.step, session.storeName) });
                    continue;
                }

                if (!session) continue;
                session.updatedAt = new Date();

                if (!textMessage && !isImage) {
                    await sock.sendMessage(remoteJid, { text: `⚠️ *Invalid Input:* Please reply with text or an image.` });
                    continue;
                }

                if (session.step === 1) {
                    if (textMessage.length < 2) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Name must be at least 2 characters.\n\n` + getStepPrompt(1, session) }); continue; }
                    session.storeName = textMessage; session.step = 2; await session.save(); await sock.sendMessage(remoteJid, { text: getStepPrompt(2, session) }); continue;
                }

                if (session.step === 2) {
                    if (cleanText === '1' || cleanText.includes('retail')) {
                        session.businessType = 'RETAIL';
                        session.category = 'Retail & Products';
                    } else if (cleanText === '2' || cleanText.includes('custom')) {
                        session.businessType = 'CUSTOM';
                        session.category = 'Custom & Bespoke';
                    } else if (cleanText === '3' || cleanText.includes('service') || cleanText.includes('transport')) {
                        session.businessType = 'SERVICE_TRANSPORT';
                        session.category = 'Services & Transport';
                    } else {
                        session.businessType = 'RETAIL';
                        session.category = textMessage;
                    }
                    session.step = 3; await session.save(); await sock.sendMessage(remoteJid, { text: `Category set to *${session.category}*! 👍\n\n` + getStepPrompt(3, session) }); continue;
                }

                if (session.step === 3) {
                    if (textMessage.length < 5) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Description too short.\n\n` + getStepPrompt(3, session) }); continue; }
                    session.description = textMessage; session.step = 4; await session.save(); await sock.sendMessage(remoteJid, { text: `Description saved! 🎯\n\n` + getStepPrompt(4, session) }); continue;
                }

                if (session.step === 4) {
                    if (session.businessType === 'CUSTOM') {
                        if (cleanText === 'no' || cleanText === '0' || cleanText === 'none') {
                            session.allowNegotiation = false;
                            session.maxDiscountPercent = 0;
                        } else {
                            const match = textMessage.match(/\d+/);
                            const discount = match ? parseInt(match[0]) : 10;
                            session.allowNegotiation = true;
                            session.maxDiscountPercent = discount;
                        }
                        session.step = 5; await session.save(); await sock.sendMessage(remoteJid, { text: `Negotiation settings saved! 🤝\n\n` + getStepPrompt(5, session) }); continue;
                    } else if (session.businessType === 'SERVICE_TRANSPORT') {
                        if (cleanText.includes('board') || cleanText === '1') session.paymentPolicy = 'PAY_ON_BOARD';
                        else if (cleanText.includes('upfront') || cleanText === '2') session.paymentPolicy = 'UPFRONT';
                        else session.paymentPolicy = 'FLEXIBLE';

                        session.step = 5; await session.save(); await sock.sendMessage(remoteJid, { text: `Payment policy saved: *${session.paymentPolicy}*! 💳\n\n` + getStepPrompt(5, session) }); continue;
                    } else {
                        const clean = cleanPhoneNumber(textMessage);
                        if (clean.length < 10) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Invalid phone number format.` }); continue; }
                        session.vendorRealPhone = clean; session.step = 6; await session.save(); await sock.sendMessage(remoteJid, { text: `Phone number *${clean}* saved! 📞\n\n` + getStepPrompt(6, session) }); continue;
                    }
                }

                if (session.step === 5) {
                    const clean = cleanPhoneNumber(textMessage);
                    if (clean.length < 10) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Invalid phone number format.` }); continue; }
                    session.vendorRealPhone = clean; session.step = 6; await session.save(); await sock.sendMessage(remoteJid, { text: `Phone number *${clean}* saved! 📞\n\n` + getStepPrompt(6, session) }); continue;
                }

                if (session.step === 6) {
                    if (cleanText === 'skip' || cleanText === 'no' || cleanText === 'none') {
                        session.bankDetails = "Direct / Cash Payment";
                        session.subaccountCode = null;
                        session.step = 7; await session.save(); await sock.sendMessage(remoteJid, { text: `Bank details skipped! ⏩\n\n` + getStepPrompt(7, session) }); continue;
                    }
                    const parts = textMessage.split('-');
                    if (parts.length < 2) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Use format "Bank Name - Account Number" or reply *SKIP*.\n\n` + getStepPrompt(6, session) }); continue; }

                    const bankName = parts[0].trim();
                    const accNo = parts[1].replace(/[^0-9]/g, '');
                    if (accNo.length < 10) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Account number must be 10 digits or reply *SKIP*.\n\n` + getStepPrompt(6, session) }); continue; }

                    await sock.sendMessage(remoteJid, { text: `⏳ Saving your bank details...` });
                    const bankCode = await lookupBankCode(bankName);

                    session.bankDetails = `${bankName} - ${accNo}`;
                    session.subaccountCode = bankCode || null;
                    session.step = 7; await session.save(); await sock.sendMessage(remoteJid, { text: `Bank details saved! 🔒\n\n` + getStepPrompt(7, session) }); continue;
                }

                if (session.step === 7) {
                    if (textMessage.length < 3) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Please provide more delivery/pickup details.\n\n` + getStepPrompt(7, session) }); continue; }
                    session.deliveryInfo = textMessage; session.step = 8; await session.save(); await sock.sendMessage(remoteJid, { text: `Delivery/Pickup info saved! 📝\n\n` + getStepPrompt(8, session) }); continue;
                }

                if (session.step === 8) {
                    if (cleanText === 'done' || cleanText === 'finish') {
                        const targetPhone = cleanPhoneNumber(session.vendorRealPhone || remoteJid);
                        await sock.sendMessage(remoteJid, { text: `⏳ *Finalizing setup... Generating your AI pairing code. Please wait a few seconds...*` });

                        await Vendor.findOneAndUpdate(
                            { phoneNumber: targetPhone },
                            { 
                                jid: remoteJid, 
                                storeName: session.storeName, 
                                category: session.category, 
                                businessType: session.businessType,
                                paymentPolicy: session.paymentPolicy,
                                allowNegotiation: session.allowNegotiation,
                                maxDiscountPercent: session.maxDiscountPercent,
                                description: session.description, 
                                bankDetails: session.bankDetails, 
                                subaccountCode: session.subaccountCode, 
                                deliveryInfo: session.deliveryInfo, 
                                faqs: session.faqs, 
                                aiActive: true 
                            },
                            { upsert: true, returnDocument: 'after' }
                        );

                        await Product.deleteMany({ vendorPhone: targetPhone });
                        if (session.products && session.products.length > 0) {
                            for (const p of session.products) {
                                const minPrice = session.allowNegotiation && session.maxDiscountPercent > 0 
                                    ? Math.round(p.price * (1 - session.maxDiscountPercent / 100))
                                    : p.price;
                                await Product.create({ 
                                    vendorPhone: targetPhone, 
                                    name: p.name, 
                                    price: p.price, 
                                    minPrice: minPrice,
                                    isNegotiable: session.allowNegotiation,
                                    imageUrl: p.imageUrl 
                                });
                            }
                        }

                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('creds.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('messages.upsert');
                            try { vendorSockets[targetPhone].ws.close(); } catch (e) { }
                            delete vendorSockets[targetPhone];
                            await delay(1500);
                        }
                        await Auth.deleteMany({ _id: { $regex: `^vendor_${targetPhone}` } });

                        const pairingCode = await spawnVendorAgent(targetPhone, session.storeName, true);
                        await RegSession.deleteOne({ phoneNumber: remoteJid });

                        if (pairingCode && pairingCode !== "ALREADY_ACTIVE" && pairingCode !== "ERROR") {
                            await sock.sendMessage(remoteJid, { text: `🎉 *SETUP COMPLETED SUCCESSFULLY!* 🚀\n\nYour store *${session.storeName}* is active!\n\n🔑 *YOUR VENDOR AI PAIRING CODE:* \`${pairingCode}\`\n\n🛡️ *Note:* Because Naxr is an automated AI, WhatsApp may show a security warning asking if you know who is linking the device. Tap *"Continue"* to authorize your bot.\n\n*How to link your AI:*\n1. Open WhatsApp Settings > Linked Devices > Link a Device > Link with phone number instead.\n2. Enter code on phone number *+${targetPhone}*! ✨` });
                        } else if (pairingCode === "ALREADY_ACTIVE") {
                            await sock.sendMessage(remoteJid, { text: `🎉 *SETUP COMPLETED!* Your AI is already connected and active! ✨` });
                        } else {
                            await sock.sendMessage(remoteJid, { text: `🎉 *SETUP COMPLETED!* 🚀\n\nYour store is fully saved!\n\n⚠️ *Meta's network experienced a slight delay so your pairing code couldn't be instantly generated.*\n\n👉 *Please reply with LINK right now to generate your code!*` });
                        }
                        continue;
                    }

                    if (isImage) {
                        await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const imageUrl = await uploadToCloudinary(buffer);

                        let price = 0; let name = textMessage || "";
                        const match = textMessage.match(/\d+/);
                        if (match) {
                            price = parseInt(match[0]);
                            name = textMessage.replace(match[0], '').replace(/[#₦$-]/g, '').trim() || "Unnamed Item";
                        }

                        if (!name || price === 0) {
                            session.pendingProductImage = imageUrl; await session.save();
                            await sock.sendMessage(remoteJid, { react: { text: "❓", key: msg.key } });
                            await sock.sendMessage(remoteJid, { text: `📸 *Photo received!* Reply with Product Name and Price (e.g., \`Vintage Shirt - 12000\`).` });
                        } else {
                            session.products.push({ name, price, imageUrl }); session.pendingProductImage = undefined; await session.save();
                            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                            await sock.sendMessage(remoteJid, { text: `✅ *Item Saved:* ${name} (₦${price.toLocaleString()})\n\nSend another, or reply *DONE* to finish! ✨` });
                        }
                        continue;
                    }

                    if (session.pendingProductImage && textMessage) {
                        let price = 0; let name = textMessage;
                        const match = textMessage.match(/\d+/);
                        if (match) price = parseInt(match[0]);

                        if (price > 0) {
                            name = textMessage.replace(match[0], '').replace(/[#₦$-]/g, '').trim() || "Unnamed Item";
                            session.products.push({ name, price, imageUrl: session.pendingProductImage }); session.pendingProductImage = undefined; await session.save();
                            await sock.sendMessage(remoteJid, { text: `✅ *Item Saved:* ${name} (₦${price.toLocaleString()})\n\nSend another photo, or reply *DONE* to finish! ✨` });
                        } else {
                            await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Please include the price numbers (e.g., \`Shirt - 12000\`).` });
                        }
                        continue;
                    }

                    if (!isImage && cleanText !== 'done' && !session.pendingProductImage) {
                        await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Please send a product photo, or reply *DONE* if you are finished adding products.` });
                    }
                }
            } catch (error) {
                console.error(`❌ Message Processing Error for ${msg?.key?.remoteJid}:`, error);
            }
        }
    });
}

// ----------------------------------------------------
// 6. FLUTTERWAVE WEBHOOK (via Svix)
// ----------------------------------------------------
app.post('/webhook/flutterwave', express.raw({ type: 'application/json' }), async (req, res) => {
    res.sendStatus(200);

    try {
        const svixSecret = process.env.SVIX_SECRET;
        if (!svixSecret) {
            console.error("❌ SVIX_SECRET not set");
            return;
        }

        const wh = new Webhook(svixSecret);
        const event = wh.verify(req.body, req.headers);

        const eventType = event.event || event['event.type'];

        if (eventType !== 'charge.completed') return;
        if (event.data?.status !== 'successful') return;

        const data = event.data;
        const txRef = data.tx_ref;

        if (!txRef?.startsWith('BOT-')) return;

        const paidAmount = data.amount;

        const order = await Order.findOne({ txRef: txRef, status: 'PENDING' });

        if (order && paidAmount >= order.amount * 0.95) {
            order.status = 'PAID';
            await order.save();

            const vSock = vendorSockets[order.vendorPhone];
            if (vSock) {
                await vSock.sendMessage(`${order.customerPhone}@s.whatsapp.net`, {
                    text: `✅ *PAYMENT CONFIRMED!*\n\nYour payment of ₦${paidAmount.toLocaleString()} has been received. Your order for *${order.productName}* is confirmed! 🎉`
                });

                await vSock.sendMessage(`${order.vendorPhone}@s.whatsapp.net`, {
                    text: `💰 *NEW PAID ORDER!*\n\nItem: ${order.productName}\nAmount: ₦${paidAmount.toLocaleString()}\nCustomer: +${order.customerPhone}`
                });
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e.message);
    }
});

// Global JSON parser must come AFTER raw webhook route
app.use(express.json());

// ----------------------------------------------------
// 7. AUTO-BOOT ALL VENDORS
// ----------------------------------------------------
async function bootAllVendors() {
    try {
        const vendors = await Vendor.find({});
        for (const v of vendors) {
            const cleanPhone = cleanPhoneNumber(v.phoneNumber);
            if (!cleanPhone) continue;
            console.log(`🔌 Preparing boot for ${v.storeName}...`);
            await delay(8000);
            spawnVendorAgent(cleanPhone, v.storeName, false);
        }
    } catch (err) { }
}

app.get('/', (req, res) => res.send('Naxr AI Engine Active! 🚀'));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🌐 Server active on port ${PORT}`));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("📦 Connected to MongoDB Atlas Cloud!"))
    .catch(err => console.error("❌ MongoDB Error:", err.message));

startNaxrMasterAgent().then(() => bootAllVendors());

// Graceful shutdown to prevent session conflicts during zero-downtime redeploys on Render
async function gracefulShutdown(signal) {
    console.log(`⚠️ Received ${signal}. Commencing graceful shutdown...`);

    server.close(() => {
        console.log("🌐 HTTP server closed.");
    });

    for (const phone in vendorSockets) {
        if (vendorSockets[phone]) {
            console.log(`🔌 Closing connection for vendor ${phone}...`);
            try {
                vendorSockets[phone].ev.removeAllListeners('connection.update');
                vendorSockets[phone].ev.removeAllListeners('creds.update');
                vendorSockets[phone].ev.removeAllListeners('messages.upsert');
                vendorSockets[phone].end();
            } catch (e) {
                console.error(`Error closing socket for ${phone}:`, e.message);
            }
        }
    }

    if (globalSock) {
        console.log(`🔌 Closing connection for master agent...`);
        try {
            globalSock.ev.removeAllListeners('connection.update');
            globalSock.ev.removeAllListeners('creds.update');
            globalSock.ev.removeAllListeners('messages.upsert');
            globalSock.end();
        } catch (e) {
            console.error(`Error closing master agent:`, e.message);
        }
    }

    try {
        await mongoose.connection.close();
        console.log("📦 MongoDB connection closed.");
    } catch (e) { }

    console.log("👋 Shutdown complete. Exiting process.");
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
