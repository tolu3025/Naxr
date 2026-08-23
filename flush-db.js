/**
 * flush-db.js
 * Complete Naxr database reset.
 * Run from Render shell: node flush-db.js
 *
 * What it wipes:
 *   - Auth (all Signal session keys, credentials → forces fresh re-link for all vendors)
 *   - RegSession (onboarding sessions)
 *
 * What it KEEPS:
 *   - Vendors (store registrations, product catalogs, AI prompts)
 *   - Messages (chat history)
 *   - Orders (payment records)
 *
 * After running:
 *   1. All vendors must re-link WhatsApp (send "Relink" in master bot chat)
 *   2. The bot will generate fresh pairing codes with clean Signal sessions
 *   3. Customers will see AI messages normally (no more "Waiting for this message")
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Auth = mongoose.model('Auth', new mongoose.Schema({ _id: String, data: String }));
const RegSession = mongoose.model('RegSession', new mongoose.Schema({}, { strict: false }));
const Vendor = mongoose.model('Vendor', new mongoose.Schema({}, { strict: false }));

async function flush() {
    console.log('\n🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected!\n');

    // ── 1. Wipe ALL auth / Signal session data ────────────────────────────
    const authResult = await Auth.deleteMany({});
    console.log(`🧹 Deleted ${authResult.deletedCount} Auth records (Signal sessions + credentials)`);

    // ── 2. Wipe onboarding sessions ────────────────────────────────────────
    const regResult = await RegSession.deleteMany({});
    console.log(`🧹 Deleted ${regResult.deletedCount} RegSession records`);

    // ── 3. Reset docsSent so vendors get welcome msg on next connect ───────
    const vendorResult = await Vendor.updateMany({}, { $set: { docsSent: false } });
    console.log(`🔄 Reset docsSent for ${vendorResult.modifiedCount} vendors`);

    console.log('\n✅ Database flush complete!');
    console.log('\n📋 Next steps:');
    console.log('   1. Restart the Render service (or wait for auto-deploy)');
    console.log('   2. Send "Relink" in the master bot chat for each vendor');
    console.log('   3. Each vendor links their WhatsApp with the fresh pairing code');
    console.log('   4. Customers will now see AI replies correctly ✅\n');

    await mongoose.disconnect();
    process.exit(0);
}

flush().catch(err => {
    console.error('❌ Flush failed:', err.message);
    process.exit(1);
});
