const fs = require('fs');

let content = fs.readFileSync('index.js', 'utf8');

const targetStr = `                const isVendorSelfChat = cleanRemoteJidNumber === cleanVendorPhone ||
                    remoteJid.includes(cleanVendorPhone) ||
                    remoteJid.endsWith('@lid') ||
                    msg.key.fromMe;

                if (!isVendorSelfChat) {
                    await Message.create({
                        vendorPhone: cleanVendorPhone,
                        customerPhone: cleanRemoteJidNumber,
                        text: textMessage || (isImage ? "[Image]" : "[Media]"),
                        fromMe: false,
                        isAi: false
                    });
                    if (typeof notifyVendorClients === 'function') {
                        notifyVendorClients(cleanVendorPhone, 'new_message', {
                            customer_phone: cleanRemoteJidNumber,
                            text: textMessage || (isImage ? "[Image]" : "[Media]"),
                            fromMe: false,
                            timestamp: new Date().toISOString()
                        });
                    }
                }`;

const replacementStr = `                const isVendorSelfChat = cleanRemoteJidNumber === cleanVendorPhone ||
                    remoteJid.includes(cleanVendorPhone) ||
                    remoteJid.endsWith('@lid');

                const isFromMe = !!msg.key.fromMe;

                if (!isVendorSelfChat) {
                    await Message.create({
                        vendorPhone: cleanVendorPhone,
                        customerPhone: cleanRemoteJidNumber,
                        text: textMessage || (isImage ? "[Image]" : "[Media]"),
                        fromMe: isFromMe,
                        isAi: false
                    });
                    if (typeof notifyVendorClients === 'function') {
                        notifyVendorClients(cleanVendorPhone, 'new_message', {
                            customer_phone: cleanRemoteJidNumber,
                            text: textMessage || (isImage ? "[Image]" : "[Media]"),
                            fromMe: isFromMe,
                            timestamp: new Date().toISOString()
                        });
                    }
                }`;

if (content.includes(targetStr)) {
    content = content.replace(targetStr, replacementStr);
    fs.writeFileSync('index.js', content, 'utf8');
    console.log("Successfully updated chat import/save logic in index.js");
} else {
    // Normalise newlines to check
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const normalizedTarget = targetStr.replace(/\r\n/g, '\n');
    const normalizedReplacement = replacementStr.replace(/\r\n/g, '\n');
    if (normalizedContent.includes(normalizedTarget)) {
        const updated = normalizedContent.replace(normalizedTarget, normalizedReplacement);
        fs.writeFileSync('index.js', updated, 'utf8');
        console.log("Successfully updated chat import/save logic in index.js (with newline normalization)");
    } else {
        console.error("Target string not found in index.js");
    }
}
