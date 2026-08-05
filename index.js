require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const axios = require('axios');
const pino = require('pino');

// ==========================================
// 1. ENVIRONMENT VARIABLES & SETUP
// ==========================================
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = process.env.ADMIN_PHONE || "2348148698365"; 
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// 2. MONGODB SCHEMAS & CONNECTION
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Atlas Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

const VendorSchema = new mongoose.Schema({
    phone: String,
    businessName: String,
    aiActive: { type: Boolean, default: true }, // 7-day trial/toggle system
    sessionData: Object
});
const Vendor = mongoose.model('Vendor', VendorSchema);

const ProductSchema = new mongoose.Schema({
    vendorId: mongoose.Schema.Types.ObjectId,
    name: String,
    price: Number,
    description: String,
    imagePath: String
});
const Product = mongoose.model('Product', ProductSchema);

const OrderSchema = new mongoose.Schema({
    vendorId: mongoose.Schema.Types.ObjectId,
    customerPhone: String,
    productName: String,
    amount: Number,
    status: { type: String, default: 'PENDING' },
    paystackRef: String
});
const Order = mongoose.model('Order', OrderSchema);

// ==========================================
// 3. UTILITY FUNCTIONS
// ==========================================
function cleanPhoneNumber(jid) {
    if (!jid) return "";
    return jid.split('@')[0].replace(/[^0-9]/g, '');
}

// 🛠️ FIX: Function to clear corrupted MongoDB auth (to fix decryption errors)
async function clearCorruptAuth() {
    try {
        // Adjust 'auths' to the exact name of the collection your MongoDB auth adapter creates
        await mongoose.connection.collection('auths').drop(); 
        console.log("🧹 SUCCESS: Corrupted MongoDB Auth collection dropped.");
        return true;
    } catch (error) {
        if (error.code === 26) {
            console.log("🧹 Auth collection already empty or does not exist.");
            return true;
        }
        console.error("❌ Failed to clear auth collection:", error);
        return false;
    }
}

// ==========================================
// 4. VENDOR AGENT LOGIC (WITH LID FIX)
// ==========================================
async function spawnVendorAgent(vendorDbRecord) {
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_vendor_${vendorDbRecord.phone}`);
    const cleanPhone = cleanPhoneNumber(vendorDbRecord.phone);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const cleanRemoteJidNumber = cleanPhoneNumber(remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
        const lowerText = text.toLowerCase().trim();

        // 🛠️ FIX 1: LID Bypasses for self-chat detection
        const altJid = msg.key.remoteJidAlt || msg.key.participantAlt || "";
        const cleanAltNumber = cleanPhoneNumber(altJid);
        
        const isVendorSelfChat = msg.key.fromMe || 
                                 cleanRemoteJidNumber === cleanPhone || 
                                 cleanAltNumber === cleanPhone;

        // --- VENDOR PERSONAL CONTROLS (Executes FIRST) ---
        if (isVendorSelfChat) {
            if (lowerText === 'stats') {
                const totalOrders = await Order.countDocuments({ vendorId: vendorDbRecord._id, status: 'PAID' });
                await sock.sendMessage(remoteJid, { text: `📊 *Your Dashboard*\n\n✅ Paid Orders: ${totalOrders}\n🤖 AI Active: ${vendorDbRecord.aiActive}` });
                return; // Stop execution here
            }
            if (lowerText === 'ai off') {
                await Vendor.findByIdAndUpdate(vendorDbRecord._id, { aiActive: false });
                await sock.sendMessage(remoteJid, { text: `🛑 AI Agent is now OFF.` });
                return;
            }
            if (lowerText === 'ai on') {
                await Vendor.findByIdAndUpdate(vendorDbRecord._id, { aiActive: true });
                await sock.sendMessage(remoteJid, { text: `✅ AI Agent is now ON.` });
                return;
            }
            if (lowerText === 'products') {
                const products = await Product.find({ vendorId: vendorDbRecord._id });
                let msgList = `🛍️ *Your Catalog:*\n\n`;
                products.forEach(p => msgList += `- ${p.name} (₦${p.price})\n`);
                await sock.sendMessage(remoteJid, { text: msgList });
                return;
            }
            // Add custom product adding logic here...
            return; // 🛑 Critical: Always return after vendor self-chat commands so the AI doesn't reply to you
        }

        // --- CUSTOMER AI LOGIC ---
        // 🛑 Stop bot from replying to its own automated messages
        if (msg.key.fromMe) return; 

        // Check if AI is active for this vendor
        const currentVendorStatus = await Vendor.findById(vendorDbRecord._id);
        if (!currentVendorStatus.aiActive) return;

        try {
            // 🛠️ FIX 2: AI Price Hallucination Patch
            const vendorProducts = await Product.find({ vendorId: vendorDbRecord._id });
            const catalogContext = vendorProducts.map(p => `${p.name}: ₦${p.price}`).join(", ");

            const aiResponse = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: `You are a strict sales assistant. DO NOT invent prices. Only quote these exact items and prices: ${catalogContext}. If the user asks for a discount, inform them politely that prices are fixed.` },
                    { role: "user", content: text }
                ]
            });

            await sock.sendMessage(remoteJid, { text: aiResponse.choices[0].message.content });

        } catch (err) {
            console.error("AI Error:", err);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) spawnVendorAgent(vendorDbRecord);
        }
    });
}

// ==========================================
// 5. MASTER ADMIN AGENT LOGIC
// ==========================================
async function startNaxrMasterAgent() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_master');
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const cleanRemoteJidNumber = cleanPhoneNumber(remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const lowerText = text.toLowerCase().trim();

        // 🛠️ FIX 3: Master Admin LID Bypasses
        const altJid = msg.key.remoteJidAlt || msg.key.participantAlt || "";
        const cleanAltNumber = cleanPhoneNumber(altJid);
        const adminPhoneClean = cleanPhoneNumber(ADMIN_PHONE);

        const isAdmin = cleanRemoteJidNumber === adminPhoneClean || 
                        cleanAltNumber === adminPhoneClean || 
                        (msg.key.fromMe && cleanPhone === adminPhoneClean);

        if (isAdmin) {
            if (lowerText === 'admin stats') {
                const totalVendors = await Vendor.countDocuments({});
                const totalOrders = await Order.countDocuments({ status: 'PAID' });
                await sock.sendMessage(remoteJid, { text: `👑 *Naxr Super Admin*\n\n👥 Total Vendors: ${totalVendors}\n✅ Total Paid Orders: ${totalOrders}` });
                return;
            }

            // 🛠️ FIX 4: Admin command to manually clear corrupt Auth
            if (lowerText === 'admin purge auth') {
                await sock.sendMessage(remoteJid, { text: `⚠️ Initiating MongoDB Auth Purge...` });
                const success = await clearCorruptAuth();
                if (success) {
                    await sock.sendMessage(remoteJid, { text: `✅ Auth purged. Server requires restart. Vendors will need to re-link.` });
                    process.exit(1); // Force Render to restart the server
                }
                return;
            }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startNaxrMasterAgent();
        }
    });
}

// ==========================================
// 6. PAYSTACK WEBHOOK & API ROUTES
// ==========================================
app.post('/paystack/webhook', express.json(), async (req, res) => {
    const event = req.body;
    if (event.event === 'charge.success') {
        const paystackRef = event.data.reference;
        await Order.findOneAndUpdate({ paystackRef }, { status: 'PAID' });
        console.log(`✅ Order paid via DVA: ${paystackRef}`);
    }
    res.sendStatus(200);
});

// Manual endpoint to clear auth if you can't access WhatsApp at all
app.post('/purge-auth', async (req, res) => {
    const success = await clearCorruptAuth();
    if (success) {
        res.status(200).send("Auth cleared. Restarting server...");
        process.exit(1); // Force Render restart
    } else {
        res.status(500).send("Failed to clear auth.");
    }
});

// ==========================================
// 7. INITIALIZATION
// ==========================================
app.listen(PORT, async () => {
    console.log(`🚀 Naxr Server running on port ${PORT}`);
    startNaxrMasterAgent();
    
    // Auto-boot all active vendors from MongoDB
    const vendors = await Vendor.find({});
    vendors.forEach(vendor => spawnVendorAgent(vendor));
});
