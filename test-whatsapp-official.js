const axios = require('axios');

const ACCESS_TOKEN = 'EAAXpSueIc6UBSRxS0Rvpp4fORcHu6Q8wAj43GJpmZCh7cA2h4NycWEnLYjRu4FWCieITbZAZB44IrmKGFLvwrVtZBVuZCSwgYko4NPvTpI6GzBjHZAv7CotbyoD1ZA8gW5qPysFJQ6DeWGROjZBrfS39uA44gfRgp4aR7YMX2x8dZCdfEnlYXPc3ipdSX4o0FbZC24z4PuHimMxZBgZCZC7eAngTfklhtfdkTKVZCHiRZASDnWyAYVafsPq4gidItdR1E9ZBkZCV2dyaSiqvlkhnunTZAUQFJhlY8ZD';
const PHONE_NUMBER_ID = '1208644078993009';

// Get recipient from command line args
const recipient = process.argv[2];

if (!recipient) {
    console.error('Error: Please provide a recipient phone number as an argument.');
    console.error('Usage: node test-whatsapp-official.js <recipient_phone_number>');
    process.exit(1);
}

async function sendTestMessage() {
    try {
        console.log(`Sending test message to ${recipient} using Phone Number ID: ${PHONE_NUMBER_ID}...`);
        
        const response = await axios.post(
            `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: recipient,
                type: 'template',
                template: {
                    name: 'hello_world',
                    language: {
                        code: 'en_US'
                    }
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Success! Message sent successfully.');
        console.log('Response:', response.data);
    } catch (err) {
        console.error('❌ Error sending message:', err.response ? err.response.data : err.message);
    }
}

sendTestMessage();
