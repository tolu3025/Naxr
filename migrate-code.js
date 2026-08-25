const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.js');
const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

console.log(`Original line count: ${lines.length}`);

// 1. Extract Vendor Loop (lines 771 to 1386 of index.js, 1-indexed -> index 770 to 1385)
// Let's verify line numbers dynamically to avoid shifting bugs
const spawnStartIdx = lines.findIndex(l => l.includes('async function spawnVendorAgent('));
const masterStartIdx = lines.findIndex(l => l.includes('async function startNaxrMasterAgent('));
const flutterwaveWebhookIdx = lines.findIndex(l => l.includes('// 6. FLUTTERWAVE WEBHOOK'));

console.log(`Found indexes - spawnStartIdx: ${spawnStartIdx}, masterStartIdx: ${masterStartIdx}, flutterwaveWebhookIdx: ${flutterwaveWebhookIdx}`);

if (spawnStartIdx === -1 || masterStartIdx === -1 || flutterwaveWebhookIdx === -1) {
    console.error('Error: Could not locate function boundary comments.');
    process.exit(1);
}

// Locate messages.upsert loop inside spawnVendorAgent
let vendorLoopStart = -1;
let vendorLoopEnd = -1;
for (let i = spawnStartIdx; i < masterStartIdx; i++) {
    if (lines[i].includes('for (const msg of m.messages) {')) {
        vendorLoopStart = i + 1; // Start of body
    }
    if (lines[i].trim() === '}' && lines[i+1]?.trim() === '});' && lines.slice(i+2, i+6).some(l => l.includes('return pairingCode'))) {
        vendorLoopEnd = i; // End of body
    }
}

// Locate messages.upsert loop inside startNaxrMasterAgent
let masterLoopStart = -1;
let masterLoopEnd = -1;
for (let i = masterStartIdx; i < flutterwaveWebhookIdx; i++) {
    if (lines[i].includes('for (const msg of m.messages) {')) {
        masterLoopStart = i + 1; // Start of body
    }
    if (lines[i] === '        }' && lines[i+1] === '    });' && lines[i+2] === '}') {
        masterLoopEnd = i; // End of body
    }
}

console.log(`Vendor Loop: ${vendorLoopStart} to ${vendorLoopEnd}`);
console.log(`Master Loop: ${masterLoopStart} to ${masterLoopEnd}`);

if (vendorLoopStart === -1 || vendorLoopEnd === -1 || masterLoopStart === -1 || masterLoopEnd === -1) {
    console.error('Error: Could not locate loop boundaries.');
    process.exit(1);
}

const vendorLoopBody = lines.slice(vendorLoopStart, vendorLoopEnd).join('\n');
const masterLoopBody = lines.slice(masterLoopStart, masterLoopEnd).join('\n');

// 2. Build replacements
const vendorReplacement = `
async function spawnVendorAgent(realPhone, storeName, requestNewCode = false) {
    console.log(\`ℹ️ spawnVendorAgent called for \${realPhone} (No-op in WhatsApp Cloud API mode)\`);
    return "ALREADY_ACTIVE";
}

async function handleVendorAgentMessage(cleanPhone, msg) {
    const cleanVendorPhone = cleanPhone;
    const vendor = await Vendor.findOne({ phoneNumber: cleanPhone });
    if (!vendor) {
        console.log(\`⚠️ handleVendorAgentMessage: Vendor record not found for \${cleanPhone}\`);
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
${vendorLoopBody}
    }
}
`;

const masterReplacement = `
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
${masterLoopBody}
    }
}
`;

const webhookRoutes = `
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
                console.log(\`⚠️ No registered vendor found for Phone ID \${recipientPhoneId}\`);
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
    const remoteJid = \`\${senderPhone}@s.whatsapp.net\`;

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
`;

// Re-assemble index.js using slices
const part1 = lines.slice(0, spawnStartIdx).join('\n');
const part2 = vendorReplacement;
const part3 = lines.slice(vendorLoopEnd + 5, masterStartIdx).join('\n'); // skip return pairingCode and closing braces
const part4 = masterReplacement;
const part5 = webhookRoutes;
// For part6, we want to start from the start of Flutterwave Webhook (flutterwaveWebhookIdx)
const part6 = lines.slice(flutterwaveWebhookIdx).join('\n');

const newCode = [part1, part2, part3, part4, part5, part6].join('\n');
fs.writeFileSync(filePath, newCode, 'utf8');

console.log('Migration successfully written to index.js!');
