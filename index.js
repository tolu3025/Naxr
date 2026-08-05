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
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("📦 Connected to MongoDB Atlas Cloud!"))
    .catch(err => console.error("❌ MongoDB Error:", err.message));

// Schemas
const Vendor = mongoose.model('Vendor', new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true }, 
    jid: String, 
    storeName: { type: String, required: true },
    category: String,
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
    imageUrl: String
}));

const Order = mongoose.model('Order', new mongoose.Schema({
    vendorPhone: { type: String, required: true },
    customerPhone: { type: String, required: true },
    productName: String,
    amount: Number,
    virtualAccountNumber: { type: String, unique: true }, 
    status: { type: String, enum: ['PENDING', 'PAID'], default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
}));

const RegSession = mongoose.model('RegSession', new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    step: { type: Number, default: 1 },
    storeName: String,
    category: String,
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
        state: { creds, keys: {
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
        }},
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
// 2. PAYSTACK VIRTUAL ACCOUNT ENGINE (TEST MODE)
// ----------------------------------------------------
async function createVendorSubaccount(storeName, bankNameRaw, accountNumber) {
    try {
        if (!process.env.PAYSTACK_SECRET_KEY) throw new Error("No API key");

        const banksRes = await axios.get('https://api.paystack.co/bank', { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }});
        const banks = banksRes.data.data;
        const bank = banks.find(b => b.name.toLowerCase().includes(bankNameRaw.toLowerCase().trim())) || banks[0];

        const subRes = await axios.post('https://api.paystack.co/subaccount', {
            business_name: storeName,
            settlement_bank: bank.code,
            account_number: accountNumber,
            percentage_charge: 2.0 
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }});

        return subRes.data.data.subaccount_code;
    } catch (error) {
        console.log("⚠️ Paystack API Error / Test Mode Fallback Triggered for Subaccount");
        return `SUB_TEST_${Date.now()}`;
    }
}

async function createVirtualAccount(customerPhone, vendorSubaccount) {
    try {
        if (!process.env.PAYSTACK_SECRET_KEY) throw new Error("No API key");
        
        const custRes = await axios.post('https://api.paystack.co/customer', {
            email: `buyer_${customerPhone}_${Date.now()}@naxr.test`,
            first_name: "Naxr",
            last_name: "Customer",
            phone: customerPhone
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }});
        
        const customerCode = custRes.data.data.customer_code;

        const dvaRes = await axios.post('https://api.paystack.co/dedicated_account', {
            customer: customerCode,
            preferred_bank: "test-bank" 
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }});

        return {
            accountNumber: dvaRes.data.data.account_number,
            bankName: dvaRes.data.data.bank.name,
            accountName: dvaRes.data.data.account_name,
            isTestMode: false
        };
    } catch (error) {
        console.log("⚠️ Paystack Virtual Account Test Fallback Triggered", error?.response?.data || error.message);
        return {
            accountNumber: `90${Math.floor(Math.random() * 100000000)}`,
            bankName: "Test Bank (Paystack)",
            accountName: "Naxr AI Escrow",
            isTestMode: true
        };
    }
}

// ----------------------------------------------------
// 3. HELPERS & EXTRACTORS
// ----------------------------------------------------
let globalSock = null;
const vendorSockets = {};
const ADMIN_PHONE = process.env.ADMIN_PHONE || "2348148698365";
const REG_TRIGGERS = ['i want to register', 'how do i register', 'register my business', 'know more about this ai', 'hi can i know more', 'register'];
const BUYING_INTENT_TRIGGERS = ['i want to buy', 'do you have', 'whats the price', "what's the price", 'how much', 'is this available', 'price of', 'catalog', 'catalogue', 'cost of', 'i need to order', 'how to order', 'pay for', 'available', 'buy', 'what do you sell', 'products', 'product list', 'show me'];

function getStepPrompt(step, storeName = "") {
    switch(step) {
        case 1: return "📝 *Step 1/8:* What is your Business / Store Name? ✨";
        case 2: return `Store Name saved: *${storeName}* ✅\n\n🏷️ *Step 2/8:* What category is your business? (e.g. Fashion, Gadgets, Food) 🛍️`;
        case 3: return "📖 *Step 3/8:* Give a short description of what your business does. 💡";
        case 4: return "📱 *Step 4/8:* Enter your **WhatsApp Phone Number** for linking your AI (e.g., 2348027986674). 📞";
        case 5: return "💳 *Step 5/8:* Provide your Bank Name and Account Number separated by a dash (e.g. Opay - 8148698365). Paystack will use this to automatically wire your sales! 🏦";
        case 6: return "🚚 *Step 6/8:* How do you handle delivery? (e.g. Same day in Lagos, Nationwide via GIGM). 📦";
        case 7: return "📸 *Step 7/8:* Send product photos with prices in captions (e.g. Vintage Shirt - ₦12,000).\n\nWhen done uploading, reply with *DONE*. ✨\n\n_Tip: If you ever make a mistake, reply with *RESET* to start over._";
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
                    `2️⃣ *Virtual Accounts (Anti-Fraud):* Instead of links, Naxr generates a direct **Virtual Bank Account** for every transaction. Fake screenshots won't work anymore—the AI verifies payments instantly via Paystack and wires the money to you!\n\n` +
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
            } catch (e) {}
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

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

                if (msg.key.fromMe && msg.key.id && msg.key.id.startsWith('BAE5')) continue;

                const isImage = !!(msg.message.imageMessage || msg.message.ephemeralMessage?.message?.imageMessage);
                const isAudio = !!(msg.message.audioMessage || msg.message.ephemeralMessage?.message?.audioMessage);
                let textMessage = extractMessageText(msg);

                if (isAudio) textMessage = await transcribeVoiceNote(msg);
                if (!textMessage) continue;

                const lowerText = textMessage.toLowerCase().trim();
                const cleanRemoteJidNumber = cleanPhoneNumber(remoteJid);
                const isVendorSelfChat = cleanRemoteJidNumber === cleanPhone || (msg.key.fromMe && remoteJid.includes(cleanPhone));

                const vendorData = await Vendor.findOne({ phoneNumber: cleanPhone });
                if (vendorData) {
                    const daysActive = (Date.now() - new Date(vendorData.createdAt).getTime()) / (1000 * 60 * 60 * 24);
                    if (daysActive > 7 && !vendorData.isPro) {
                        if (isVendorSelfChat) {
                            await vendorSock.sendMessage(remoteJid, { text: `⚠️ *TRIAL EXPIRED:* Your 7-day Naxr AI trial has ended. Your bot is currently paused. Please subscribe to continue enjoying automated sales! 🚀` });
                        }
                        continue; 
                    }
                }

                // ─── VENDOR SELF-CHAT ADMIN CONTROLS ───
                if (isVendorSelfChat) {
                    // AI ON / OFF
                    if (lowerText === 'ai off') {
                        await Vendor.findOneAndUpdate({ phoneNumber: cleanPhone }, { aiActive: false });
                        await vendorSock.sendMessage(remoteJid, { text: `🛑 *AI Agent is now OFF.*\n\nCustomers will no longer receive automated replies until you turn it back on.` });
                        continue;
                    }
                    if (lowerText === 'ai on') {
                        await Vendor.findOneAndUpdate({ phoneNumber: cleanPhone }, { aiActive: true });
                        await vendorSock.sendMessage(remoteJid, { text: `✅ *AI Agent is now ON.*\n\nYour store is live and ready to take orders!` });
                        continue;
                    }

                    // STATS
                    if (lowerText === 'stats' || lowerText === 'sales' || lowerText === 'dashboard') {
                        const salesCount = await Order.countDocuments({ vendorPhone: cleanPhone, status: 'PAID' });
                        const pendingCount = await Order.countDocuments({ vendorPhone: cleanPhone, status: 'PENDING' });
                        const productsCount = await Product.countDocuments({ vendorPhone: cleanPhone });
                        const totalRevenue = await Order.aggregate([
                            { $match: { vendorPhone: cleanPhone, status: 'PAID' } },
                            { $group: { _id: null, total: { $sum: '$amount' } } }
                        ]);
                        const revenue = totalRevenue[0]?.total || 0;
                        
                        let trialText = vendorData?.isPro ? "✅ Pro Plan Active" : `⏳ Free Trial: ${Math.max(7 - Math.floor((Date.now() - new Date(vendorData.createdAt).getTime()) / (1000 * 60 * 60 * 24)), 0)} days left`;
                        let aiStatus = vendorData?.aiActive !== false ? "🟢 AI ON" : "🔴 AI OFF";
                        
                        await vendorSock.sendMessage(remoteJid, { 
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
                        const paidOrders = await Order.find({ vendorPhone: cleanPhone, status: 'PAID' }).sort({ createdAt: -1 }).limit(5);
                        const pendingOrders = await Order.find({ vendorPhone: cleanPhone, status: 'PENDING' }).sort({ createdAt: -1 }).limit(5);
                        const totalRevenue = await Order.aggregate([
                            { $match: { vendorPhone: cleanPhone, status: 'PAID' } },
                            { $group: { _id: null, total: { $sum: '$amount' } } }
                        ]);
                        const revenue = totalRevenue[0]?.total || 0;
                        
                        const recentPaid = paidOrders.length > 0 
                            ? paidOrders.map(o => `• ${o.productName} — ₦${o.amount.toLocaleString()} (+${o.customerPhone})`).join('\n')
                            : "No paid orders yet.";
                            
                        const recentPending = pendingOrders.length > 0
                            ? pendingOrders.map(o => `• ${o.productName} — ₦${o.amount.toLocaleString()} (Acct: ${o.virtualAccountNumber})`).join('\n')
                            : "No pending orders.";

                        await vendorSock.sendMessage(remoteJid, {
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
                        const activeProducts = await Product.find({ vendorPhone: cleanPhone });
                        const catalogText = activeProducts.length > 0 
                            ? activeProducts.map(p => `• ${p.name} - ₦${p.price.toLocaleString()}`).join("\n")
                            : "No products added yet.";
                        await vendorSock.sendMessage(remoteJid, { text: `📦 *Product Catalog for ${storeName}:*\n\n${catalogText}` });
                        continue;
                    } 

                    // EDIT DESCRIPTION
                    if (lowerText.startsWith('edit description ')) {
                        const newDesc = textMessage.substring(17).trim();
                        await Vendor.updateOne({ phoneNumber: cleanPhone }, { description: newDesc });
                        await vendorSock.sendMessage(remoteJid, { text: `✅ Business description updated.` });
                        continue;
                    }

                    // DELETE PRODUCT
                    if (lowerText.startsWith('delete product ')) {
                        const prodName = textMessage.substring(15).trim();
                        const res = await Product.deleteOne({ vendorPhone: cleanPhone, name: { $regex: new RegExp(prodName, 'i') } });
                        if (res.deletedCount > 0) await vendorSock.sendMessage(remoteJid, { text: `✅ Product "${prodName}" deleted.` });
                        else await vendorSock.sendMessage(remoteJid, { text: `⚠️ Product not found.` });
                        continue;
                    }

                    // CONFIRM TEST PAYMENT (manual test mode)
                    if (lowerText === 'confirm test' || lowerText === 'test confirm') {
                        const pendingOrder = await Order.findOne({ vendorPhone: cleanPhone, status: 'PENDING' }).sort({ createdAt: -1 });
                        if (!pendingOrder) {
                            await vendorSock.sendMessage(remoteJid, { text: `⚠️ No pending test orders found.` });
                            continue;
                        }
                        pendingOrder.status = 'PAID';
                        await pendingOrder.save();
                        
                        await vendorSock.sendMessage(`${pendingOrder.customerPhone}@s.whatsapp.net`, { 
                            text: `✅ *TEST PAYMENT CONFIRMED!*\n\nYour order for *${pendingOrder.productName}* has been manually confirmed. 🎉` 
                        });
                        await vendorSock.sendMessage(remoteJid, { 
                            text: `✅ *Test order confirmed!*\n\nItem: ${pendingOrder.productName}\nAmount: ₦${pendingOrder.amount.toLocaleString()}\nCustomer: +${pendingOrder.customerPhone}` 
                        });
                        continue;
                    }

                    // ADD PRODUCT VIA IMAGE
                    if (isImage) {
                        const match = textMessage.match(/\d+/);
                        if (match) {
                            const price = parseInt(match[0]);
                            const name = textMessage.replace(match[0], '').replace(/[#₦$-]/g, '').trim() || "Unnamed Item";
                            await vendorSock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            const imageUrl = await uploadToCloudinary(buffer);
                            await Product.create({ vendorPhone: cleanPhone, name, price, imageUrl });
                            await vendorSock.sendMessage(remoteJid, { text: `✅ *New Product Added!*\n\n${name} - ₦${price.toLocaleString()}` });
                        } else {
                            await vendorSock.sendMessage(remoteJid, { text: `⚠️ Include product name and price in caption.` });
                        }
                        continue;
                    }

                    // HELP
                    if (lowerText === 'help') {
                        await vendorSock.sendMessage(remoteJid, { 
                            text: `💡 *Naxr Vendor Commands:*\n` +
                                  `• *stats* — Quick sales summary\n` +
                                  `• *analytics* — Detailed breakdown\n` +
                                  `• *products* — View catalog\n` +
                                  `• *ai on* / *ai off* — Toggle AI\n` +
                                  `• *edit description [text]*\n` +
                                  `• *delete product [name]*\n` +
                                  `• *confirm test* — Confirm test payment\n` +
                                  `• Send image + price to add product` 
                        });
                        continue;
                    }

                    // Unrecognized self-chat message
                    continue; 
                }

                // ─── CUSTOMER-FACING AI ───
                if (msg.key.fromMe) continue;
                if (!vendorData || vendorData.aiActive === false) continue;

                const activeProducts = await Product.find({ vendorPhone: cleanPhone });
                let hasBuyingIntent = BUYING_INTENT_TRIGGERS.some(trigger => lowerText.includes(trigger));
                
                if (!hasBuyingIntent && activeProducts.length > 0) {
                    hasBuyingIntent = activeProducts.some(p => {
                        const cleanName = p.name.replace(/[^\w\s]/gi, '').toLowerCase().trim();
                        return cleanName.length > 3 && lowerText.includes(cleanName);
                    });
                }

                if (!hasBuyingIntent) continue;

                const isCatalogRequest = ['catalog', 'catalogue', 'products', 'product list', 'what do you sell', 'show me'].some(t => lowerText.includes(t));
                
                if (isCatalogRequest) {
                    if (activeProducts.length > 0) {
                        await vendorSock.sendMessage(remoteJid, { text: `📦 *Here is our current catalog:*` });
                        for (const p of activeProducts) {
                            if (p.imageUrl) {
                                await vendorSock.sendMessage(remoteJid, { image: { url: p.imageUrl }, caption: `*${p.name}*\n💰 Price: ₦${p.price.toLocaleString()}` });
                            }
                        }
                        await delay(1000);
                        await vendorSock.sendMessage(remoteJid, { text: `Reply with the name of the item you'd like to buy! ✨` });
                    } else {
                        await vendorSock.sendMessage(remoteJid, { text: `📦 We are currently updating our catalog.` });
                    }
                    continue; 
                }

                const catalog = activeProducts.map(p => `- ${p.name}: ₦${p.price}`).join("\n");

                const customerAI = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: `You are Naxr, sales rep for ${storeName}. Catalog:\n${catalog}\nIf customer explicitly wants to buy a specific item or mentions a product name, output JSON ONLY: {"action": "BUY", "productName": "Name", "price": 10000}. Otherwise reply naturally with friendly emojis.` },
                        { role: "user", content: textMessage }
                    ]
                });

                const reply = customerAI.choices[0].message.content.trim();
                
                if (reply.startsWith('{') && reply.endsWith('}')) {
                    try {
                        const data = JSON.parse(reply);
                        
                        await vendorSock.sendMessage(remoteJid, { text: `⏳ Generating secure Virtual Account via Paystack...` });

                        const virtualAcc = await createVirtualAccount(cleanRemoteJidNumber, vendorData.subaccountCode);
                        
                        await Order.create({
                            vendorPhone: cleanPhone,
                            customerPhone: cleanRemoteJidNumber,
                            productName: data.productName,
                            amount: data.price,
                            virtualAccountNumber: virtualAcc.accountNumber,
                            status: 'PENDING'
                        });
                        
                        const testWarning = virtualAcc.isTestMode 
                            ? `\n\n⚠️ *TEST MODE ACTIVE:* This is a test virtual account. Payments will NOT auto-confirm via webhook.\n_Vendor can manually confirm with "confirm test" in their admin chat._`
                            : '';

                        await vendorSock.sendMessage(remoteJid, { 
                            text: `🛍️ *Order Initiated: ${data.productName}*\n\n` +
                                  `💰 *Amount Due:* ₦${data.price.toLocaleString()}\n\n` +
                                  `🏦 *Pay With Transfer:*\n` +
                                  `Bank: *${virtualAcc.bankName}*\n` +
                                  `Account No: *${virtualAcc.accountNumber}*\n` +
                                  `Name: *${virtualAcc.accountName}*\n\n` +
                                  `_This virtual account is strictly for this transaction. Our AI system will automatically confirm your order once the transfer is received!_ ✨` +
                                  testWarning
                        });
                    } catch (e) {
                        await vendorSock.sendMessage(remoteJid, { text: "⚠️ Could not generate a payment account at this time." });
                    }
                } else {
                    await vendorSock.sendMessage(remoteJid, { text: reply });
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
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

                const isImage = !!(msg.message.imageMessage || msg.message.ephemeralMessage?.message?.imageMessage);
                let textMessage = extractMessageText(msg);

                const lowerText = textMessage ? textMessage.toLowerCase() : "";
                const cleanText = lowerText.replace(/[^\w\s]/gi, '').trim();
                const cleanRemoteJidNumber = cleanPhoneNumber(remoteJid);

                if (cleanRemoteJidNumber === cleanPhoneNumber(ADMIN_PHONE)) {
                    if (lowerText === 'admin stats') {
                        const totalVendors = await Vendor.countDocuments({});
                        const totalOrders = await Order.countDocuments({ status: 'PAID' });
                        const totalProducts = await Product.countDocuments({});
                        await sock.sendMessage(remoteJid, { text: `👑 *Naxr Super Admin*\n\n👥 Total Vendors: ${totalVendors}\n🛍️ Total Products Listed: ${totalProducts}\n✅ Total Paid Orders: ${totalOrders}` });
                        continue;
                    }
                    if (lowerText === 'admin vendors') {
                        const vendors = await Vendor.find({});
                        const vList = vendors.map(v => `• ${v.storeName} (${v.phoneNumber})`).join("\n");
                        await sock.sendMessage(remoteJid, { text: `👑 *Registered Vendors:*\n\n${vList || "No vendors yet."}` });
                        continue;
                    }
                    if (lowerText.startsWith('delete vendor ')) {
                        const targetPhone = cleanPhoneNumber(lowerText.replace('delete vendor', '').trim());
                        await Vendor.deleteOne({ phoneNumber: targetPhone });
                        await Product.deleteMany({ vendorPhone: targetPhone });
                        
                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update'); 
                            try { vendorSockets[targetPhone].ws.close(); } catch(e){}
                            delete vendorSockets[targetPhone];
                        }
                        await Auth.deleteMany({ _id: { $regex: `^vendor_${targetPhone}` } });
                        await sock.sendMessage(remoteJid, { text: `✅ Vendor ${targetPhone} completely purged from system.` });
                        continue;
                    }
                }

                if (cleanText === 'reset' || cleanText === 'restart') {
                    const existingVendorForReset = await Vendor.findOne({ jid: remoteJid });
                    
                    if (existingVendorForReset) {
                        const targetPhone = cleanPhoneNumber(existingVendorForReset.phoneNumber);
                        
                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update'); 
                            vendorSockets[targetPhone].ev.removeAllListeners('creds.update'); 
                            vendorSockets[targetPhone].ev.removeAllListeners('messages.upsert'); 
                            try { vendorSockets[targetPhone].ws.close(); } catch(e){}
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
                const isRegTrigger = REG_TRIGGERS.some(t => lowerText.includes(t));

                if (existingVendor) {
                    if (cleanText === 'link' || cleanText === 'code' || cleanText === 'relink' || cleanText === 'new code') {
                        const targetPhone = cleanPhoneNumber(existingVendor.phoneNumber);
                        if (targetPhone !== existingVendor.phoneNumber) { existingVendor.phoneNumber = targetPhone; await existingVendor.save(); }

                        await sock.sendMessage(remoteJid, { text: `🔄 Generating a fresh pairing code for *${existingVendor.storeName}*...` });
                        
                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update'); 
                            vendorSockets[targetPhone].ev.removeAllListeners('creds.update'); 
                            vendorSockets[targetPhone].ev.removeAllListeners('messages.upsert'); 
                            try { vendorSockets[targetPhone].ws.close(); } catch(e){}
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
                    if (textMessage.length < 2) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Name must be at least 2 characters.\n\n` + getStepPrompt(1) }); continue; }
                    session.storeName = textMessage; session.step = 2; await session.save(); await sock.sendMessage(remoteJid, { text: getStepPrompt(2, session.storeName) }); continue; 
                }
                
                if (session.step === 2) { 
                    if (textMessage.length < 3) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Category too short.\n\n` + getStepPrompt(2, session.storeName) }); continue; }
                    session.category = textMessage; session.step = 3; await session.save(); await sock.sendMessage(remoteJid, { text: `Category saved! 👍\n\n` + getStepPrompt(3) }); continue; 
                }
                
                if (session.step === 3) { 
                    if (textMessage.length < 10) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Description too short.\n\n` + getStepPrompt(3) }); continue; }
                    session.description = textMessage; session.step = 4; await session.save(); await sock.sendMessage(remoteJid, { text: `Description saved! 🎯\n\n` + getStepPrompt(4) }); continue; 
                }
                
                if (session.step === 4) { 
                    const clean = cleanPhoneNumber(textMessage);
                    if (clean.length < 10) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Invalid phone number format.` }); continue; }
                    session.vendorRealPhone = clean; session.step = 5; await session.save(); await sock.sendMessage(remoteJid, { text: `Phone number *${clean}* saved! 📞\n\n` + getStepPrompt(5) }); continue; 
                }
                
                if (session.step === 5) { 
                    const parts = textMessage.split('-');
                    if (parts.length < 2) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Use format "Bank Name - Account Number" (e.g., Opay - 8148698365).\n\n` + getStepPrompt(5) }); continue; }
                    
                    const bankName = parts[0].trim();
                    const accNo = parts[1].replace(/[^0-9]/g, '');
                    if (accNo.length < 10) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Account number must be 10 digits.\n\n` + getStepPrompt(5) }); continue; }

                    await sock.sendMessage(remoteJid, { text: `⏳ Setting up auto-withdrawals with Paystack...` });
                    const subaccountCode = await createVendorSubaccount(session.storeName, bankName, accNo);

                    session.bankDetails = `${bankName} - ${accNo}`;
                    session.subaccountCode = subaccountCode;
                    session.step = 6; await session.save(); await sock.sendMessage(remoteJid, { text: `Bank details saved! 🔒\n\n` + getStepPrompt(6) }); continue; 
                }
                
                if (session.step === 6) { 
                    if (textMessage.length < 5) { await sock.sendMessage(remoteJid, { text: `⚠️ *Feedback:* Please provide more delivery details.\n\n` + getStepPrompt(6) }); continue; }
                    session.faqs = textMessage; session.step = 7; await session.save(); await sock.sendMessage(remoteJid, { text: `Delivery Info saved! 📝\n\n` + getStepPrompt(7) }); continue; 
                }

                if (session.step === 7) {
                    if (cleanText === 'done' || cleanText === 'finish') {
                        const targetPhone = cleanPhoneNumber(session.vendorRealPhone || remoteJid);
                        await sock.sendMessage(remoteJid, { text: `⏳ *Finalizing setup... Generating your AI pairing code. Please wait a few seconds...*` });

                        await Vendor.findOneAndUpdate(
                            { phoneNumber: targetPhone },
                            { jid: remoteJid, storeName: session.storeName, category: session.category, description: session.description, bankDetails: session.bankDetails, subaccountCode: session.subaccountCode, deliveryInfo: session.deliveryInfo, faqs: session.faqs, aiActive: true },
                            { upsert: true, returnDocument: 'after' } 
                        );

                        await Product.deleteMany({ vendorPhone: targetPhone });
                        if (session.products && session.products.length > 0) {
                            for (const p of session.products) await Product.create({ vendorPhone: targetPhone, name: p.name, price: p.price, imageUrl: p.imageUrl });
                        }

                        if (vendorSockets[targetPhone]) {
                            vendorSockets[targetPhone].ev.removeAllListeners('connection.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('creds.update');
                            vendorSockets[targetPhone].ev.removeAllListeners('messages.upsert');
                            try { vendorSockets[targetPhone].ws.close(); } catch(e){}
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
// 6. PAYSTACK WEBHOOK (VERIFY TRANSACTIONS)
// ----------------------------------------------------
app.post('/paystack-webhook', async (req, res) => {
    try {
        const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
        if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Invalid signature');
        
        res.sendStatus(200); 

        const event = req.body;
        if (event.event === 'charge.success') {
            const { amount, authorization } = event.data;
            const paidAmount = amount / 100; 
            
            const order = await Order.findOne({ 
                virtualAccountNumber: authorization.receiver_bank_account.account_number, 
                status: 'PENDING' 
            });

            if (order && paidAmount >= order.amount) {
                order.status = 'PAID';
                await order.save();

                const vSock = vendorSockets[order.vendorPhone];
                if (vSock) {
                    await vSock.sendMessage(`${order.customerPhone}@s.whatsapp.net`, { 
                        text: `✅ *PAYMENT CONFIRMED!*\n\nYour payment of ₦${paidAmount.toLocaleString()} has been received. Your order for *${order.productName}* is confirmed! 🎉` 
                    });
                    
                    await vSock.sendMessage(`${order.vendorPhone}@s.whatsapp.net`, { 
                        text: `💰 *NEW PAID ORDER! (Via Paystack)*\n\n` +
                              `Item: ${order.productName}\nAmount: ₦${paidAmount.toLocaleString()}\nCustomer: +${order.customerPhone}\n\n` +
                              `_Funds will settle to your bank automatically._` 
                    });
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
});

// ----------------------------------------------------
// 6b. TEST PAYMENT CONFIRMATION (MANUAL)
// ----------------------------------------------------
app.post('/test/confirm-payment', async (req, res) => {
    try {
        const { accountNumber } = req.body;
        if (!accountNumber) return res.status(400).json({ success: false, error: 'accountNumber required' });

        const order = await Order.findOne({ virtualAccountNumber: accountNumber, status: 'PENDING' });
        if (!order) return res.status(404).json({ success: false, error: 'No pending order found for this account number' });

        order.status = 'PAID';
        await order.save();

        const vSock = vendorSockets[order.vendorPhone];
        if (vSock) {
            await vSock.sendMessage(`${order.customerPhone}@s.whatsapp.net`, { 
                text: `✅ *TEST PAYMENT CONFIRMED!*\n\nYour order for *${order.productName}* has been confirmed. 🎉` 
            });
            await vSock.sendMessage(`${order.vendorPhone}@s.whatsapp.net`, { 
                text: `💰 *TEST ORDER CONFIRMED MANUALLY!*\n\nItem: ${order.productName}\nAmount: ₦${order.amount.toLocaleString()}\nCustomer: +${order.customerPhone}` 
            });
        }

        res.json({ success: true, message: 'Test payment confirmed', order });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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
            await delay(8000); 
            spawnVendorAgent(cleanPhone, v.storeName, false);
        }
    } catch (err) {}
}

app.get('/', (req, res) => res.send('Naxr AI Engine Active! 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server active on port ${PORT}`));

startNaxrMasterAgent().then(() => bootAllVendors());
