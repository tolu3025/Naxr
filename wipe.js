require('dotenv').config();
const mongoose = require('mongoose');

// Define the Auth schema so Mongoose knows where to look
const Auth = mongoose.model('Auth', new mongoose.Schema({ _id: String, data: String }));

console.log("⏳ Connecting to MongoDB Atlas...");

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log("✅ Connected!");
        
        // Find and delete all keys that belong to the master agent
        const result = await Auth.deleteMany({ _id: { $regex: '^master_agent_session' } });
        
        console.log(`🧹 SUCCESS: Wiped ${result.deletedCount} corrupted master keys!`);
        console.log("🔌 Disconnecting...");
        
        process.exit(0); // Close the script safely
    })
    .catch(err => {
        console.error("❌ Error:", err.message);
        process.exit(1);
    });
