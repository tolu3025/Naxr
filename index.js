require('dotenv').config();
const {
    default: makeWASocket,
    initAuthCreds,
    BufferJSON,
    proto,
    delay,
    downloadMediaMessage,
    DisconnectReason,
    useMultiFileAuthState
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

const Message = mongoose.model('Message', new mongoose.Schema({
    vendorPhone: { type: String, required: true },
    customerPhone: { type: String, required: true },
    text: { type: String, required: true },
    fromMe: { type: Boolean, required: true },
    isAi: { type: Boolean, default: false },
    messageId: String,
    timestamp: { type: Date, default: Date.now }
}));

const Otp = mongoose.model('Otp', new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    code: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 300 }
}));

const Session = mongoose.model('Session', new mongoose.Schema({
    vendorPhone: { type: String, required: true },
    token: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, expires: 2592000 }
}));

const Knowledge = mongoose.model('Knowledge', new mongoose.Schema({
    vendorPhone: { type: String, required: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    sourceUrl: String,
    createdAt: { type: Date, default: Date.now }
}));

async function clearAuthSession(sessionId) {
    try {
        await Auth.deleteMany({ _id: { $regex: `^${sessionId}` } });
        const dir = path.join(process.cwd(), 'auth_states', sessionId);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (err) {
        console.error(`⚠️ clearAuthSession error [${sessionId}]:`, err.message);
    }
}

// Wipe only the per-contact Signal session keys and sender-key data that go
// stale across Render restarts (causing Bad MAC / MessageCounterError).
// Credentials, pre-keys, and signed-pre-keys are intentionally preserved so
// the device stays registered without re-pairing.
async function cleanStaleSessionKeys(sessionId) {
    // No-op to prevent wiping session/sender keys on restarts/reconnects.
    // Wiping these keys causes decryption failures ("Waiting for this message") for customers.
    console.log(`ℹ️ cleanStaleSessionKeys skipped for [${sessionId}] to preserve chat encryption state.`);
}

async function useMongoDBAuthState(sessionId = 'creds') {
    const dir = path.join(process.cwd(), 'auth_states', sessionId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Download from MongoDB to local disk if local files don't exist yet
    // or to sync up with MongoDB on restart
    try {
        const docs = await Auth.find({ _id: { $regex: `^${sessionId}-` } }).lean();
        for (const doc of docs) {
            const filename = doc._id.substring(sessionId.length + 1);
            const fileBase = filename === 'creds' ? 'creds' : filename;
            const filePath = path.join(dir, `${fileBase}.json`);
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, doc.data);
            }
        }
    } catch (err) {
        console.error(`⚠️ useMongoDBAuthState download error [${sessionId}]:`, err.message);
    }

    // Use native Baileys multi-file auth state on local files
    const { state, saveCreds: nativeSaveCreds } = await useMultiFileAuthState(dir);

    return {
        state: {
            creds: state.creds,
            keys: {
                get: async (type, ids) => {
                    return state.keys.get(type, ids);
                },
                set: async (data) => {
                    await state.keys.set(data);
                    
                    // Sync updates/deletes to MongoDB asynchronously
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const keyId = `${category}-${id}`;
                            const fullDbId = `${sessionId}-${keyId}`;
                            if (value) {
                                Auth.updateOne(
                                    { _id: fullDbId },
                                    { $set: { data: JSON.stringify(value, BufferJSON.replacer) } },
                                    { upsert: true }
                                ).catch(err => console.error(`⚠️ Auth sync set error [${fullDbId}]:`, err.message));
                            } else {
                                Auth.deleteOne({ _id: fullDbId }).catch(err => console.error(`⚠️ Auth sync delete error [${fullDbId}]:`, err.message));
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await nativeSaveCreds();
            try {
                await Auth.updateOne(
                    { _id: `${sessionId}-creds` },
                    { $set: { data: JSON.stringify(state.creds, BufferJSON.replacer) } },
                    { upsert: true }
                );
            } catch (err) {
                console.error(`⚠️ Auth sync saveCreds error [${sessionId}]:`, err.message);
            }
        }
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
// 2. KORAPAY VIRTUAL ACCOUNT & BANK LOOKUP ENGINE
// ----------------------------------------------------
async function lookupBankCode(bankNameRaw) {
    try {
        const apiKey = process.env.KORAPAY_SECRET_KEY;
        if (!apiKey) return null;

        const banksRes = await axios.get('https://api.korapay.com/merchant/api/v1/misc/banks?countryCode=NG', {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 10000
        });

        const banks = banksRes.data?.data;
        if (!banks || !Array.isArray(banks)) return null;

        const bank = banks.find(b => b.name.toLowerCase().includes(bankNameRaw.toLowerCase().trim())) || banks[0];
        return bank ? bank.code : null;
    } catch (error) {
        console.error("⚠️ Korapay Bank Code Error (non-fatal):", error?.response?.data || error.message);
        return null;
    }
}

async function createKorapayVirtualAccount(customerPhone, amount, productName) {
    try {
        const apiKey = process.env.KORAPAY_SECRET_KEY;
        if (!apiKey) throw new Error("No Korapay API key");

        const ref = `BOT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const response = await axios.post('https://api.korapay.com/merchant/api/v1/virtual-bank-account', {
            account_name: `Naxr - ${customerPhone}`,
            account_reference: ref,
            bank_code: "035", // Wema Bank is reliable and default
            customer: {
                name: `Buyer ${customerPhone}`,
                email: `buyer_${customerPhone}_${Date.now()}@naxr.com`
            }
        }, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        if (response.data && response.data.status === true) {
            return {
                accountNumber: response.data.data.account_number,
                bankName: response.data.data.bank_name,
                accountName: response.data.data.account_name || "Naxr Payment",
                txRef: ref
            };
        } else {
            throw new Error(response.data.message || "Failed to generate virtual account");
        }
    } catch (error) {
        console.error("⚠️ Korapay Virtual Account Error:", error?.response?.data || error.message);
        throw new Error("Failed to create virtual account. Please verify your Korapay keys.");
    }
}

// ----------------------------------------------------
// 3. HELPERS & EXTRACTORS
// ----------------------------------------------------
let globalSock = null;
const vendorSockets = {};
const ADMIN_PHONE = process.env.ADMIN_PHONE || "2348148698365";

const botMessageIds = new Set();

const sendQueue = {};

async function safeSendMessage(sock, jid, content, options = {}) {
    if (!sock) return null;
    
    // Create a unique key for the queue based on socket configuration and receiver JID
    const queueKey = `${sock.authState?.creds?.me?.id || 'default'}-${jid}`;
    if (!sendQueue[queueKey]) {
        sendQueue[queueKey] = Promise.resolve();
    }

    const sendPromise = sendQueue[queueKey].then(async () => {
        try {
            // Trigger "composing" presence status to mimic human typing
            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch (e) {}

            // Random delay between 1.5 to 3.5 seconds to feel organic
            const typingTime = 1500 + Math.random() * 2000;
            await delay(typingTime);

            try {
                await sock.sendPresenceUpdate('paused', jid);
            } catch (e) {}

            const sendFunc = sock.originalSendMessage || sock.sendMessage;
            const sent = await sendFunc.bind(sock)(jid, content, options);
            if (sent?.key?.id) {
                botMessageIds.add(sent.key.id);
                if (botMessageIds.size > 3000) {
                    const firstKey = botMessageIds.values().next().value;
                    botMessageIds.delete(firstKey);
                }
                
                try {
                    let vendorPhone = Object.keys(vendorSockets).find(phone => vendorSockets[phone] === sock);
                    if (!vendorPhone && sock === globalSock) {
                        vendorPhone = 'master_agent';
                    }
                    if (vendorPhone && jid && jid.endsWith('@s.whatsapp.net')) {
                        const customerPhone = cleanPhoneNumber(jid);
                        const text = content.text || content.caption || "";
                        if (text && customerPhone !== vendorPhone) {
                            await Message.create({
                                vendorPhone,
                                customerPhone,
                                text,
                                fromMe: true,
                                isAi: !options.manual,
                                messageId: sent.key.id
                            });
                            if (typeof notifyVendorClients === 'function') {
                                notifyVendorClients(vendorPhone, 'ai_replied', {
                                    customer_phone: customerPhone,
                                    text,
                                    fromMe: true,
                                    isAi: !options.manual,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.error("Failed to log outgoing message:", e.message);
                }
            }
            
            // Post-send cool-off spacing of 500ms before sending the next one
            await delay(500);
            return sent;
        } catch (err) {
            console.error("❌ safeSendMessage Error:", err.message);
            return null;
        }
    });

    sendQueue[queueKey] = sendPromise.catch(() => {});
    return sendPromise;
}

const REG_TRIGGERS = [
    'i want to register', 'how do i register', 'register my business', 'know more about this ai',
    'hi can i know more', 'register', 'registration', 'sign up', 'signup', 'onboard',
    'create store', 'create account', 'join naxr', 'setup bot', 'set up bot', 'link my whatsapp',
    'tell me about naxr', 'how does this work', 'how to use naxr', 'get started', 'how to register', 'yes'
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
    console.log(`ℹ️ spawnVendorAgent called for ${realPhone} (No-op in WhatsApp Cloud API mode)`);
    return "ALREADY_ACTIVE";
}

async function handleVendorAgentMessage(cleanPhone, msg) {
    const cleanVendorPhone = cleanPhone;
    const vendor = await Vendor.findOne({ phoneNumber: cleanPhone });
    if (!vendor) {
        console.log(`⚠️ handleVendorAgentMessage: Vendor record not found for ${cleanPhone}`);
        return;
    }
    const storeName = vendor.storeName;
    const vendorBank = vendor.bankDetails || "";
    const paymentPolicy = vendor.paymentPolicy || "UPFRONT";

    const vendorSock = {
        sendMessage: (jid, content, options = {}) => {
            return safeSendMessage(cleanPhone, jid, content, options);
        }
    };

    const messages = [msg];
    for (const msg of messages) {
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
                    remoteJid.endsWith('@lid');

                const isFromMe = !!msg.key.fromMe;

                if (!isVendorSelfChat) {
                    await Message.create({
                        vendorPhone: cleanVendorPhone,
                        customerPhone: cleanRemoteJidNumber,
                        text: textMessage || (isImage ? "[Image]" : "[Media]"),
                        fromMe: isFromMe,
                        isAi: false,
                        messageId: msg.key.id
                    });
                    if (typeof notifyVendorClients === 'function') {
                        notifyVendorClients(cleanVendorPhone, 'new_message', {
                            customer_phone: cleanRemoteJidNumber,
                            text: textMessage || (isImage ? "[Image]" : "[Media]"),
                            fromMe: isFromMe,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

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
                                `🛍️️ Active Products: ${productsCount}\n` +
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
                                            caption: `🛍️️ *${p.name}*\n💰 Price: ₦${p.price.toLocaleString()}`
                                        });
                                    } catch (e) {
                                        await safeSendMessage(vendorSock, remoteJid, { text: `🛍️️ *${p.name}*\n💰 Price: ₦${p.price.toLocaleString()}` });
                                    }
                                } else {
                                    await safeSendMessage(vendorSock, remoteJid, { text: `🛍️️ *${p.name}*\n💰 Price: ₦${p.price.toLocaleString()}` });
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
                        `âš ï¸  *Please Note:* This receipt is an automated proof that you submitted your payment. It does *NOT* mean your order is automatically confirmed. The vendor must manually verify the transfer in their bank app before shipping. Thank you for your patience! ðŸ™ `;

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

                if (isAudio && textMessage.trim().length < 3) continue;

                const isCatalogRequest = CATALOG_TRIGGERS.some(t => lowerText.includes(t));

                if (isCatalogRequest) {
                    if (activeProducts.length > 0) {
                        await safeSendMessage(vendorSock, remoteJid, { text: `📦 *Here is our current catalog for ${storeName}:*` });
                        for (const p of activeProducts) {
                            if (p.imageUrl) {
                                try {
                                    await safeSendMessage(vendorSock, remoteJid, {
                                        image: { url: p.imageUrl },
                                        caption: `🛍️️ *${p.name}*\n💰 *Price:* ₦${p.price.toLocaleString()}\n\n👉 Reply *"I want to buy ${p.name}"* to place an order!`
                                    });
                                } catch (e) {
                                    await safeSendMessage(vendorSock, remoteJid, {
                                        text: `🛍️️ *${p.name}*\n💰 *Price:* ₦${p.price.toLocaleString()}\n\n👉 Reply *"I want to buy ${p.name}"* to place an order!`
                                    });
                                }
                            } else {
                                await safeSendMessage(vendorSock, remoteJid, {
                                    text: `🛍️️ *${p.name}*\n💰 *Price:* ₦${p.price.toLocaleString()}\n\n👉 Reply *"I want to buy ${p.name}"* to place an order!`
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

                // Fetch vendor custom knowledge base/FAQs
                const vendorKnowledgeDocs = await Knowledge.find({ vendorPhone: cleanVendorPhone });
                const knowledgeText = vendorKnowledgeDocs.map(k => `Title: ${k.title}\nContent: ${k.content}`).join("\n\n");

                const customerAI = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content: `You are Naxr, sales & booking rep for ${storeName} (${vendorData.category || 'Business'}). Today's date is ${todayDateStr}.
Business Description: ${vendorData.description || 'N/A'}
Delivery/Service Info: ${vendorData.deliveryInfo || 'N/A'}

Additional Store Knowledge & FAQ Info:
${knowledgeText || 'No additional custom knowledge loaded.'}

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

                        const isPayOnBoard = (paymentPolicy === 'PAY_ON_BOARD' || businessType === 'SERVICE_TRANSPORT');
                        const vendorBank = vendorData.bankDetails || "Vendor Direct Account";

                        if (isPayOnBoard) {
                            const orderRefNumber = `NX-${Date.now().toString().slice(-6)}`;
                            await Order.create({
                                vendorPhone: cleanVendorPhone,
                                customerPhone: cleanRemoteJidNumber,
                                productName: data.productName,
                                amount: data.price,
                                paymentPolicy: paymentPolicy,
                                virtualAccountNumber: orderRefNumber,
                                status: 'BOOKED'
                            });
                            if (typeof notifyVendorClients === 'function') {
                                notifyVendorClients(cleanVendorPhone, 'new_order', {
                                    amount: data.price,
                                    productName: data.productName
                                });
                            }

                            // (notification already sent above)

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
                            try {
                                await safeSendMessage(vendorSock, remoteJid, { text: `⏳ *Generating your secure payment account details...*` });
                                const vAcc = await createKorapayVirtualAccount(cleanRemoteJidNumber, data.price, data.productName);

                                await Order.create({
                                    vendorPhone: cleanVendorPhone,
                                    customerPhone: cleanRemoteJidNumber,
                                    productName: data.productName,
                                    amount: data.price,
                                    paymentPolicy: paymentPolicy,
                                    virtualAccountNumber: vAcc.accountNumber,
                                    txRef: vAcc.txRef,
                                    status: 'PENDING'
                                });
                                if (typeof notifyVendorClients === 'function') {
                                    notifyVendorClients(cleanVendorPhone, 'new_order', {
                                        amount: data.price,
                                        productName: data.productName
                                    });
                                }

                                if (typeof notifyVendorClients === 'function') {
                                    notifyVendorClients(cleanVendorPhone, 'new_order', {
                                        amount: data.price,
                                        productName: data.productName
                                    });
                                }

                                await safeSendMessage(vendorSock, remoteJid, {
                                    text: `🛍️️ *Order Initiated: ${data.productName}*\n\n` +
                                        `💰 *Amount Due:* ₦${data.price.toLocaleString()}\n\n` +
                                        `🏦 *Payment Account Details (Kora Bank Transfer):*\n` +
                                        `• Bank: *${vAcc.bankName}*\n` +
                                        `• Account Number: *${vAcc.accountNumber}*\n` +
                                        `• Account Name: *${vAcc.accountName}*\n\n` +
                                        `👉 Please transfer ₦${data.price.toLocaleString()} to the account above. Your payment will be verified automatically in 1-2 minutes! ✨`
                                });
                            } catch (err) {
                                console.error("❌ Korapay account generation error, falling back to static:", err.message);
                                const orderRefNumber = `NX-${Date.now().toString().slice(-6)}`;
                                
                                await Order.create({
                                    vendorPhone: cleanVendorPhone,
                                    customerPhone: cleanRemoteJidNumber,
                                    productName: data.productName,
                                    amount: data.price,
                                    paymentPolicy: paymentPolicy,
                                    virtualAccountNumber: orderRefNumber,
                                    status: 'PENDING'
                                });
                                if (typeof notifyVendorClients === 'function') {
                                    notifyVendorClients(cleanVendorPhone, 'new_order', {
                                        amount: data.price,
                                        productName: data.productName
                                    });
                                }

                                await safeSendMessage(vendorSock, remoteJid, {
                                    text: `🛍️️ *Order Initiated: ${data.productName}*\n\n` +
                                        `💰 *Amount Due:* ₦${data.price.toLocaleString()}\n\n` +
                                        `🏦 *Payment Account Details:*\n` +
                                        `Bank & Account: *${vendorBank}* (Manual Transfer)\n` +
                                        `Order Ref: *${orderRefNumber}*\n\n` +
                                        `👉 Please make payment to the account above and reply by sending *PAID* or sharing your receipt! ✨\n` +
                                        `*(Note: The vendor will verify your transfer and confirm your order).*`
                                });
                            }
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
                                caption: `🛍️️ *${matchedProduct.name}*\n💰 *Price:* ₦${matchedProduct.price.toLocaleString()}`
                            });
                        } catch (e) { }
                    }
                }
            } catch (error) {
                console.error(`❌ Message Processing Error for ${msg?.key?.remoteJid}:`, error);
            }
    }
}


// ----------------------------------------------------
// 5. MASTER ONBOARDING AGENT SOCKET
// ----------------------------------------------------

async function startNaxrMasterAgent(isReconnect = false) {
    console.log("ℹ️ startNaxrMasterAgent called (No-op in WhatsApp Cloud API mode)");
}

async function handleMasterAgentMessage(msg) {
    const sock = {
        sendMessage: (jid, content, options = {}) => {
            return safeSendMessage('master_agent', jid, content, options);
        }
    };

    const messages = [msg];
    for (const msg of messages) {
            try {
                if (!msg.message) continue;
                if (msg.key.id && botMessageIds.has(msg.key.id)) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

                const isImage = !!(msg.message.imageMessage || msg.message.ephemeralMessage?.message?.imageMessage);
                let textMessage = extractMessageText(msg);

                const cleanRemoteJidNumber = cleanPhoneNumber(remoteJid);
                const isFromMe = !!msg.key.fromMe;

                // Log all incoming messages for master agent to database
                await Message.create({
                    vendorPhone: 'master_agent',
                    customerPhone: cleanRemoteJidNumber,
                    text: textMessage || (isImage ? "[Image]" : "[Media]"),
                    fromMe: isFromMe,
                    isAi: false,
                    messageId: msg.key.id
                }).catch(() => {});

                const lowerText = textMessage ? textMessage.toLowerCase().trim() : "";
                const cleanText = lowerText.replace(/[^\w\s]/gi, '').trim();
                const cleanAdminPhone = cleanPhoneNumber(ADMIN_PHONE);

                const isAdminMessage = cleanRemoteJidNumber === cleanAdminPhone || remoteJid.includes(cleanAdminPhone) || msg.key.fromMe;

                if (isAdminMessage) {
                    if (lowerText === 'admin stats' || lowerText === 'stats') {
                        const totalVendors = await Vendor.countDocuments({});
                        const totalOrders = await Order.countDocuments({ status: 'PAID' });
                        const totalProducts = await Product.countDocuments({});
                        await safeSendMessage(sock, remoteJid, { text: `👑 *Naxr Super Admin*\n\n👥 Total Vendors: ${totalVendors}\n🛍️️ Total Products Listed: ${totalProducts}\n✅ Total Paid Orders: ${totalOrders}` });
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
                        // Flush both MongoDB AND in-memory cache so the new socket
                        // starts with completely fresh Signal sessions. Without this,
                        // stale sessions in the in-memory cache cause the bot to encrypt
                        // replies with old keys → customer sees "Waiting for this message."
                        await clearAuthSession(`vendor_${targetPhone}`);
                        await cleanStaleSessionKeys(`vendor_${targetPhone}`);

                        const newCode = await spawnVendorAgent(targetPhone, existingVendor.storeName, true);

                        if (newCode && newCode !== "ALREADY_ACTIVE" && newCode !== "ERROR") {
                            await sock.sendMessage(remoteJid, {
                                text: `🔑 *YOUR VENDOR AI PAIRING CODE:* \`${newCode}\`\n\n🛍️¡️ *Note:* Because Naxr is an automated AI, WhatsApp may show a security warning asking if you know who is linking the device. Tap *"Continue"* to authorize your bot.\n\n1. Go to WhatsApp Settings > Linked Devices > Link a Device.\n2. Tap Link with phone number instead.\n3. Enter the code above.`
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

                if (!session) {
                    await sock.sendMessage(remoteJid, { text: `👋 Hi there! Are you looking to automate sales & booking for your business with Naxr AI?\n\n👉 Reply *"REGISTER"* or *"YES"* to set up your AI store agent in 2 minutes! ✨` });
                    continue;
                }
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
                            await sock.sendMessage(remoteJid, { text: `🎉 *SETUP COMPLETED SUCCESSFULLY!* 🚀\n\nYour store *${session.storeName}* is active!\n\n🔑 *YOUR VENDOR AI PAIRING CODE:* \`${pairingCode}\`\n\n🛍️¡️ *Note:* Because Naxr is an automated AI, WhatsApp may show a security warning asking if you know who is linking the device. Tap *"Continue"* to authorize your bot.\n\n*How to link your AI:*\n1. Open WhatsApp Settings > Linked Devices > Link a Device > Link with phone number instead.\n2. Enter code on phone number *+${targetPhone}*! ✨` });
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
}


// ----------------------------------------------------
// WhatsApp Webhook (Meta Cloud API)
// ----------------------------------------------------
app.get('/webhook/whatsapp', (req, res) => {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'naxr_verify_token';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === verifyToken) {
            console.log('✅ Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            console.log('❌ Webhook verification failed: Token mismatch.');
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

app.post('/webhook/whatsapp', async (req, res) => {
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    try {
        const entries = body.entry || [];
        for (const entry of entries) {
            const changes = entry.changes || [];
            for (const change of changes) {
                const value = change.value || {};
                const messages = value.messages || [];
                const metadata = value.metadata || {};
                const recipientPhoneId = metadata.phone_number_id;

                for (const msg of messages) {
                    await handleIncomingMetaMessage(recipientPhoneId, msg, value.contacts?.[0]);
                }
            }
        }
    } catch (err) {
        console.error('❌ Error processing WhatsApp Webhook:', err.message);
    }
});

async function handleIncomingMetaMessage(recipientPhoneId, metaMsg, contact) {
    const masterPhoneId = process.env.WHATSAPP_MASTER_PHONE_NUMBER_ID;
    const isMaster = recipientPhoneId === masterPhoneId;

    let vendorPhone = 'master_agent';
    let accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!isMaster) {
        const vendor = await Vendor.findOne({ whatsappPhoneNumberId: recipientPhoneId });
        if (vendor) {
            vendorPhone = vendor.phoneNumber;
            if (vendor.whatsappAccessToken) accessToken = vendor.whatsappAccessToken;
        } else {
            const defaultVendor = await Vendor.findOne({});
            if (defaultVendor) {
                vendorPhone = defaultVendor.phoneNumber;
                if (defaultVendor.whatsappAccessToken) accessToken = defaultVendor.whatsappAccessToken;
            } else {
                console.log(`⚠️ No registered vendor found for Phone ID ${recipientPhoneId}`);
                return;
            }
        }
    }

    let text = '';
    let isImage = false;
    let mediaId = null;

    if (metaMsg.type === 'text') {
        text = metaMsg.text?.body || '';
    } else if (metaMsg.type === 'interactive') {
        const interactive = metaMsg.interactive || {};
        if (interactive.type === 'button_reply') {
            text = interactive.button_reply?.title || '';
        } else if (interactive.type === 'list_reply') {
            text = interactive.list_reply?.title || '';
        }
    } else if (metaMsg.type === 'image') {
        isImage = true;
        mediaId = metaMsg.image?.id;
        text = metaMsg.image?.caption || '';
    }

    if (!text && !isImage) return;

    const senderPhone = metaMsg.from;
    const remoteJid = `${senderPhone}@s.whatsapp.net`;

    const mockMsg = {
        isMeta: true,
        mediaId: mediaId,
        phoneNumberId: recipientPhoneId,
        accessToken: accessToken,
        key: {
            id: metaMsg.id,
            remoteJid: remoteJid,
            fromMe: false
        },
        messageTimestamp: parseInt(metaMsg.timestamp),
        message: isImage ? {
            imageMessage: {
                caption: text
            }
        } : {
            conversation: text
        }
    };

    if (isMaster) {
        await handleMasterAgentMessage(mockMsg);
    } else {
        await handleVendorAgentMessage(vendorPhone, mockMsg);
    }
}

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

// ----------------------------------------------------
// 6.5. KORAPAY WEBHOOK
// ----------------------------------------------------
app.post('/webhook/korapay', express.raw({ type: 'application/json' }), async (req, res) => {
    res.sendStatus(200);

    try {
        const signature = req.headers['x-kora-signature'];
        const secretKey = process.env.KORAPAY_SECRET_KEY;

        if (!signature || !secretKey) {
            console.error("❌ Missing Korapay signature or secret key");
            return;
        }

        // Verify signature
        const hmac = crypto.createHmac('sha256', secretKey);
        hmac.update(req.body);
        const computedSignature = hmac.digest('hex');

        if (computedSignature !== signature) {
            console.error("❌ Invalid Korapay webhook signature");
            return;
        }

        const payload = JSON.parse(req.body.toString());
        const eventType = payload.event;
        if (eventType !== 'charge.success') return;

        const data = payload.data;
        const txRef = data.reference;

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
        console.error("Korapay Webhook Error:", e.message);
    }
});

// Global JSON parser must come AFTER raw webhook route
app.use(express.json());

// CORS and Preflight
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type,authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

const checkAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid authorization header" });
    }
    const token = authHeader.split(" ")[1];
    const session = await Session.findOne({ token });
    if (!session) {
        return res.status(401).json({ error: "Invalid token or expired session" });
    }
    req.vendorPhone = session.vendorPhone;
    next();
};

// Admin Pairing Routes
app.get('/api/admin/pair-code', async (req, res) => {
    try {
        const myNumber = cleanPhoneNumber(ADMIN_PHONE);
        if (!myNumber) {
            return res.status(400).json({ error: "ADMIN_PHONE is not configured" });
        }
        if (globalSock) {
            const code = await globalSock.requestPairingCode(myNumber);
            return res.json({ pairingCode: code });
        } else {
            return res.status(500).json({ error: "Master agent socket not initialized" });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/reset-session', async (req, res) => {
    try {
        if (globalSock) {
            globalSock.ev.removeAllListeners('connection.update');
            globalSock.ev.removeAllListeners('creds.update');
            globalSock.ev.removeAllListeners('messages.upsert');
            try { globalSock.ws.close(); } catch (e) { }
            globalSock = null;
        }
        await clearAuthSession('master_agent_session');
        startNaxrMasterAgent();
        res.json({ message: "Admin master agent session reset. Check console logs or call /api/admin/pair-code for new pairing code." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/check-env', async (req, res) => {
    let gitCommit = "N/A";
    try {
        gitCommit = require('child_process').execSync('git rev-parse HEAD').toString().trim();
    } catch (e) {}
    return res.json({
        has_mongodb_uri: !!process.env.MONGODB_URI,
        has_openai_key: !!process.env.OPENAI_API_KEY,
        openai_key_prefix: process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.substring(0, 12) + '...' : null,
        has_cloudinary_key: !!process.env.CLOUDINARY_API_KEY,
        has_cloudinary_secret: !!process.env.CLOUDINARY_API_SECRET,
        has_korapay_secret: !!process.env.KORAPAY_SECRET_KEY,
        has_admin_phone: !!process.env.ADMIN_PHONE,
        admin_phone: process.env.ADMIN_PHONE,
        port: process.env.PORT,
        git_commit: gitCommit
    });
});
// Portal Authentication Routes
app.post('/api/auth/vendor/login', async (req, res) => {
    try {
        const { phone } = req.body;
        const cleaned = cleanPhoneNumber(phone);
        if (!cleaned) return res.status(400).json({ error: "Invalid phone number" });

        const vendor = await Vendor.findOne({ phoneNumber: cleaned });
        if (!vendor) return res.status(404).json({ error: "Vendor not registered. Please register on WhatsApp first." });

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await Otp.findOneAndUpdate({ phone: cleaned }, { code, createdAt: new Date() }, { upsert: true });

        const targetJid = `${cleaned}@s.whatsapp.net`;
        const text = `🔐 *Naxr Merchant Portal Login Code:* ${code}\n\nDo not share this code with anyone. It expires in 5 minutes.`;

        let sent = false;
        if (vendorSockets[cleaned]) {
            await safeSendMessage(vendorSockets[cleaned], targetJid, { text });
            sent = true;
        } else if (globalSock) {
            await safeSendMessage(globalSock, targetJid, { text });
            sent = true;
        }

        return res.json({ success: sent, message: sent ? "OTP sent successfully to your WhatsApp!" : "Failed to send OTP via WhatsApp. Please try again." });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/vendor/verify-otp', async (req, res) => {
    try {
        const { phone, otp } = req.body;
        const cleaned = cleanPhoneNumber(phone);
        if (!cleaned || !otp) return res.status(400).json({ error: "Missing phone or OTP" });

        const record = await Otp.findOne({ phone: cleaned, code: otp });
        if (!record) return res.status(400).json({ error: "Invalid OTP or expired." });

        await Otp.deleteOne({ phone: cleaned });

        const token = crypto.randomBytes(32).toString('hex');
        await Session.create({ vendorPhone: cleaned, token });

        return res.json({ token });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Vendor Settings & Dashboard
app.get('/api/vendor/:phone/dashboard', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized access" });

        const vendor = await Vendor.findOne({ phoneNumber: phone });
        if (!vendor) return res.status(404).json({ error: "Vendor not found" });

        const paidCount = await Order.countDocuments({ vendorPhone: phone, status: 'PAID' });
        const pendingCount = await Order.countDocuments({ vendorPhone: phone, status: 'PENDING' });

        const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
        const startOfWeek = new Date(); startOfWeek.setDate(startOfWeek.getDate() - 7);
        const startOfMonth = new Date(); startOfMonth.setDate(startOfMonth.getDate() - 30);

        const todayRev = await Order.aggregate([
            { $match: { vendorPhone: phone, status: 'PAID', createdAt: { $gte: startOfToday } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const weekRev = await Order.aggregate([
            { $match: { vendorPhone: phone, status: 'PAID', createdAt: { $gte: startOfWeek } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const monthRev = await Order.aggregate([
            { $match: { vendorPhone: phone, status: 'PAID', createdAt: { $gte: startOfMonth } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);

        const recentOrdersDocs = await Order.find({ vendorPhone: phone })
            .sort({ createdAt: -1 })
            .limit(10);

        const recentOrders = recentOrdersDocs.map(o => ({
            id: o._id.toString(),
            customerPhone: o.customerPhone,
            amount: o.amount,
            status: o.status,
            date: o.createdAt.toISOString()
        }));

        return res.json({
            business_name: vendor.storeName,
            auth_connected: !!(vendorSockets[phone] && vendorSockets[phone].authState?.creds?.registered),
            unread_messages: 0,
            isPro: vendor.isPro,
            response_mode: vendor.aiActive ? "auto" : "manual",
            revenue: {
                today: todayRev[0]?.total || 0,
                week: weekRev[0]?.total || 0,
                month: monthRev[0]?.total || 0
            },
            recent_orders: recentOrders
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/vendor/:phone/settings', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized access" });

        const vendor = await Vendor.findOne({ phoneNumber: phone });
        if (!vendor) return res.status(404).json({ error: "Vendor not found" });

        return res.json({
            storeName: vendor.storeName,
            category: vendor.category,
            bankDetails: vendor.bankDetails,
            deliveryInfo: vendor.deliveryInfo,
            aiActive: vendor.aiActive,
            allowNegotiation: vendor.allowNegotiation,
            maxDiscountPercent: vendor.maxDiscountPercent
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/vendor/:phone/settings', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized access" });

        const { response_mode, allowNegotiation, maxDiscountPercent } = req.body;
        const updates = {};
        if (response_mode !== undefined) updates.aiActive = (response_mode === "auto");
        if (allowNegotiation !== undefined) updates.allowNegotiation = allowNegotiation;
        if (maxDiscountPercent !== undefined) updates.maxDiscountPercent = maxDiscountPercent;

        const vendor = await Vendor.findOneAndUpdate({ phoneNumber: phone }, updates, { new: true });
        if (!vendor) return res.status(404).json({ error: "Vendor not found" });

        return res.json({ success: true, vendor });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Products Routes
app.get('/api/vendor/:phone/products', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized access" });

        const products = await Product.find({ vendorPhone: phone });
        return res.json(products);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/vendor/:phone/products', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const multer = require('multer');
        const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('image');
        await new Promise((resolve) => upload(req, res, resolve));

        const name = req.body.name;
        const price = req.body.price;
        const isNegotiable = req.body.isNegotiable === 'true';
        const minPrice = req.body.minPrice ? parseFloat(req.body.minPrice) : parseFloat(price);
        let imageUrl = req.body.imageUrl || null;

        if (!name || !price) return res.status(400).json({ error: "Missing name or price" });

        if (req.file) {
            imageUrl = await uploadToCloudinary(req.file.buffer);
        } else if (imageUrl && imageUrl.startsWith('data:image')) {
            const base64Data = imageUrl.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            imageUrl = await uploadToCloudinary(buffer);
        }

        const p = await Product.create({ vendorPhone: phone, name, price: parseFloat(price), imageUrl, isNegotiable, minPrice });
        return res.json(p);
    } catch (e) {
        console.error("Product create error:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.delete('/api/vendor/:phone/products/:id', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        await Product.deleteOne({ vendorPhone: phone, _id: req.params.id });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});
app.get('/api/vendor/:phone/pair-code', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const vendor = await Vendor.findOne({ phoneNumber: phone });
        if (!vendor) return res.status(404).json({ error: "Vendor not found" });

        if (vendorSockets[phone]) {
            vendorSockets[phone].ev.removeAllListeners('connection.update');
            vendorSockets[phone].ev.removeAllListeners('creds.update');
            vendorSockets[phone].ev.removeAllListeners('messages.upsert');
            try { vendorSockets[phone].ws.close(); } catch (e) { }
            delete vendorSockets[phone];
            await delay(1500);
        }
        await Auth.deleteMany({ _id: { $regex: `^vendor_${phone}` } });

        const code = await spawnVendorAgent(phone, vendor.storeName, true);
        if (code && code !== "ERROR") {
            return res.json({ pairingCode: code });
        } else {
            return res.status(500).json({ error: "Failed to generate pairing code. Please try again." });
        }
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Knowledge Base Routes
app.get('/api/vendor/:phone/knowledge', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const k = await Knowledge.find({ vendorPhone: phone });
        return res.json(k);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/vendor/:phone/knowledge', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const { title, content } = req.body;
        if (!title || !content) return res.status(400).json({ error: "Missing title or content" });

        const k = await Knowledge.create({ vendorPhone: phone, title, content });
        return res.json(k);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/vendor/:phone/knowledge/scrape', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const { url } = req.body;
        if (!url) return res.status(400).json({ error: "Missing URL" });

        const response = await axios.get(url);
        const text = response.data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const title = text.slice(0, 30) + "...";
        const k = await Knowledge.create({ vendorPhone: phone, title, content: text.slice(0, 2000), sourceUrl: url });
        return res.json(k);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.delete('/api/vendor/:phone/knowledge/:id', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        await Knowledge.deleteOne({ vendorPhone: phone, _id: req.params.id });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Realtime Chat & Inbox Routes
app.get('/api/vendor/:phone/chats', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const chats = await Message.aggregate([
            { $match: { vendorPhone: phone } },
            { $sort: { timestamp: -1 } },
            { $group: {
                _id: "$customerPhone",
                last_message: { $first: "$text" },
                last_message_time: { $first: "$timestamp" },
                ai_handled: { $first: "$isAi" }
            }},
            { $project: {
                customer_phone: "$_id",
                last_message: 1,
                last_message_time: 1,
                unread_count: { $literal: 0 },
                ai_handled: 1
            }}
        ]);
        return res.json(chats);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/vendor/:phone/chats/:customerPhone', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const messages = await Message.find({ vendorPhone: phone, customerPhone: req.params.customerPhone }).sort({ timestamp: 1 });
        const list = messages.map(m => ({
            id: m._id.toString(),
            text: m.text,
            fromMe: m.fromMe,
            isAi: m.isAi,
            timestamp: m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }));
        return res.json(list);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/vendor/:phone/send-message', checkAuth, async (req, res) => {
    try {
        const phone = req.params.phone;
        if (req.vendorPhone !== phone) return res.status(403).json({ error: "Unauthorized" });

        const { customer_phone, message } = req.body;
        const targetJid = `${customer_phone}@s.whatsapp.net`;
        const vSock = vendorSockets[phone];
        if (vSock) {
            await safeSendMessage(vSock, targetJid, { text: message }, { manual: true });
            return res.json({ success: true });
        } else {
            return res.status(400).json({ error: "WhatsApp socket not connected for this vendor." });
        }
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

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
            await delay(10000); // Slightly longer gap to avoid WA rate limits on boot
            spawnVendorAgent(cleanPhone, v.storeName, false);
        }
    } catch (err) { }
}

// ── Secret flush endpoint (browser accessible, no shell needed) ──────────
// Wipes all Auth (Signal sessions + creds) and RegSession data.
// Vendors keep their store/product/order data but must re-link WhatsApp.
// URL: https://naxr.onrender.com/flush-sessions?secret=naxr2024reset
app.get('/flush-sessions', async (req, res) => {
    const FLUSH_SECRET = process.env.FLUSH_SECRET || 'naxr2024reset';
    if (req.query.secret !== FLUSH_SECRET) {
        return res.status(403).send('❌ Forbidden: wrong secret key.');
    }
    try {
        // 1. Close all live vendor sockets cleanly first
        for (const phone in vendorSockets) {
            try {
                vendorSockets[phone].ev.removeAllListeners();
                vendorSockets[phone].end();
            } catch (e) {}
            delete vendorSockets[phone];
        }
        if (globalSock) {
            try { globalSock.ev.removeAllListeners(); globalSock.end(); } catch (e) {}
            globalSock = null;
        }

        // 2. Clear in-memory auth cache
        authStateCache.clear();

        // 3. Wipe Auth collection (all Signal sessions + credentials)
        const authResult = await Auth.deleteMany({});

        // 4. Wipe onboarding sessions
        const regResult = await RegSession.deleteMany({});

        // 5. Reset docsSent so vendors get welcome message on next connect
        await Vendor.updateMany({}, { $set: { docsSent: false } });

        // 6. Restart all agents with fresh state
        setTimeout(() => startNaxrMasterAgent().then(() => bootAllVendors()), 3000);

        res.send(`
            <html><body style="font-family:sans-serif;padding:40px;background:#0f0f0f;color:#fff">
            <h2>✅ Naxr Session Flush Complete!</h2>
            <p>🧹 Deleted <b>${authResult.deletedCount}</b> Auth records (Signal sessions + credentials)</p>
            <p>🧹 Deleted <b>${regResult.deletedCount}</b> onboarding sessions</p>
            <p>🔄 All vendor stores kept. Bot is restarting with fresh sessions...</p>
            <hr>
            <h3>📋 Next Steps:</h3>
            <ol>
                <li>Wait 30 seconds for the bot to fully restart</li>
                <li>Send <b>"Relink"</b> in the master bot chat for each vendor</li>
                <li>Each vendor links their WhatsApp with the fresh pairing code</li>
                <li>Customers will now see AI replies correctly ✅</li>
            </ol>
            <p style="color:#aaa;font-size:12px">Vendor store data, products, orders and messages were NOT deleted.</p>
            </body></html>
        `);
    } catch (e) {
        res.status(500).send(`❌ Flush failed: ${e.message}`);
    }
});

app.get('/', (req, res) => res.send('Naxr AI Engine Active! 🚀'));


const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🌐 Server active on port ${PORT}`));

const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on("connection", (socket) => {
    const vendorPhone = socket.handshake.query.vendor_phone;
    if (vendorPhone) {
        socket.join(vendorPhone);
        console.log(`🔌 Socket client connected for vendor ${vendorPhone}`);
    }

    socket.on("register_vendor", (data) => {
        if (data?.vendor_phone) {
            socket.join(data.vendor_phone);
            console.log(`🔌 Socket client registered for vendor ${data.vendor_phone}`);
        }
    });

    socket.on("disconnect", () => {
        console.log("🔌 Socket client disconnected");
    });
});

function notifyVendorClients(vendorPhone, eventName, data) {
    io.to(vendorPhone).emit(eventName, data);
}

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
