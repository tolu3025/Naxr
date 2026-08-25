const axios = require('axios');

const token = 'EAAXpSueIc6UBSRxS0Rvpp4fORcHu6Q8wAj43GJpmZCh7cA2h4NycWEnLYjRu4FWCieITbZAZB44IrmKGFLvwrVtZBVuZCSwgYko4NPvTpI6GzBjHZAv7CotbyoD1ZA8gW5qPysFJQ6DeWGROjZBrfS39uA44gfRgp4aR7YMX2x8dZCdfEnlYXPc3ipdSX4o0FbZC24z4PuHimMxZBgZCZC7eAngTfklhtfdkTKVZCHiRZASDnWyAYVafsPq4gidItdR1E9ZBkZCV2dyaSiqvlkhnunTZAUQFJhlY8ZD';

async function testToken() {
    try {
        console.log('Sending request to Facebook Graph API...');
        
        // 1. Get user details / token owner details
        const meRes = await axios.get('https://graph.facebook.com/v20.0/me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('Me response:', meRes.data);

        // 2. Fetch Business Portfolios (Businesses) owned by the user
        console.log('Fetching business portfolios...');
        const businessesRes = await axios.get('https://graph.facebook.com/v20.0/me/businesses', {
            headers: { Authorization: `Bearer ${token}` }
        }).catch(err => {
            return { error: true, message: err.response ? err.response.data : err.message };
        });

        if (businessesRes.error) {
            console.log('Failed to fetch businesses:', JSON.stringify(businessesRes.message, null, 2));
            return;
        }

        console.log('Businesses:', businessesRes.data);
        const businesses = businessesRes.data.data || [];

        for (const business of businesses) {
            console.log(`\nFetching WABAs for Business: ${business.name} (${business.id})...`);
            const wabaRes = await axios.get(`https://graph.facebook.com/v20.0/${business.id}/whatsapp_business_accounts`, {
                headers: { Authorization: `Bearer ${token}` }
            }).catch(err => ({ error: true, message: err.response ? err.response.data : err.message }));

            if (wabaRes.error) {
                console.log(`Failed to fetch WABAs for Business ${business.id}:`, JSON.stringify(wabaRes.message, null, 2));
                continue;
            }

            console.log('WABA Accounts:', wabaRes.data);
            const wabaAccounts = wabaRes.data.data || [];

            for (const waba of wabaAccounts) {
                console.log(`Fetching phone numbers for WABA: ${waba.name} (${waba.id})...`);
                const phoneRes = await axios.get(`https://graph.facebook.com/v20.0/${waba.id}/phone_numbers`, {
                    headers: { Authorization: `Bearer ${token}` }
                }).catch(err => ({ error: true, message: err.response ? err.response.data : err.message }));

                if (phoneRes.error) {
                    console.log(`Failed to fetch phone numbers for WABA ${waba.id}:`, JSON.stringify(phoneRes.message, null, 2));
                } else {
                    console.log('Phone Numbers:', phoneRes.data);
                }
            }
        }
    } catch (err) {
        console.error('Error testing token:', err.response ? err.response.data : err.message);
    }
}

testToken();
