require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI not found. Make sure .env exists in this folder.');
    process.exit(1);
}

async function dissolve() {
    await mongoose.connect(MONGODB_URI);
    console.log('📦 Connected to MongoDB');

    const Vendor = mongoose.model('Vendor', new mongoose.Schema({}));
    const Product = mongoose.model('Product', new mongoose.Schema({}));
    const Order = mongoose.model('Order', new mongoose.Schema({}));
    const RegSession = mongoose.model('RegSession', new mongoose.Schema({}));
    const Auth = mongoose.model('Auth', new mongoose.Schema({ _id: String }));

    const v = await Vendor.deleteMany({});
    const p = await Product.deleteMany({});
    const o = await Order.deleteMany({});
    const s = await RegSession.deleteMany({});
    const a = await Auth.deleteMany({ _id: { $regex: '^vendor_' } });

    console.log(`\n✅ DISSOLVED SUCCESSFULLY!`);
    console.log(`   Vendors: ${v.deletedCount}`);
    console.log(`   Products: ${p.deletedCount}`);
    console.log(`   Orders: ${o.deletedCount}`);
    console.log(`   Sessions: ${s.deletedCount}`);
    console.log(`   Vendor Auths: ${a.deletedCount}`);
    console.log(`\n🚀 Now go to Render dashboard and click "Manual Deploy" → "Deploy latest commit"`);
    
    process.exit(0);
}

dissolve().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
