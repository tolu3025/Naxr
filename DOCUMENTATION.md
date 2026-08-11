# Naxr WhatsApp AI Vendor Agent: Developer Documentation

Welcome to the developer documentation for **Naxr**, an automated, multi-tenant WhatsApp AI Sales Agent and payment automation engine designed for vendors in Nigeria. 

This document covers everything from the system architecture, code organization, key services, third-party integrations (baileys, OpenAI, Flutterwave, Svix), and a complete setup guide.

---

## 1. System Architecture Overview

Naxr operates as a multi-client server wrapper. It is built on a hub-and-spoke model:

1. **Master Onboarding Agent**: A master WhatsApp session (`master_agent_session`) that interacts with new vendors. It registers store names, categories, descriptions, payouts info, products, and generates pairing codes to link vendor accounts.
2. **Spoke Vendor Agents**: Independent, spawned WhatsApp sockets (`vendorSockets[phoneNumber]`) running for each registered vendor. Each socket uses individual session creds stored in MongoDB.
3. **Admin Dashboard (Self-Chat)**: Allows the vendor to manage their store inside their own WhatsApp chat by replying to themselves with commands (`stats`, `analytics`, `products`, `ai off`, etc.).
4. **Customer-Facing Sales AI**: Uses OpenAI's `gpt-4o-mini` to detect buying intent, send catalog images with pricing, handle customer FAQs, initiate order records, and process transfer verification.
5. **Payment Settlement & Webhooks**: Generates dynamic transfer references and utilizes Flutterwave + Svix to receive automated notifications and confirm payments.

```
       ┌────────────────────────┐
       │   WhatsApp Master Bot  │ (Store Onboarding & Device Linking)
       └───────────┬────────────┘
                   │
         Registers in Mongo
                   │
                   ▼
       ┌────────────────────────┐
       │  Spawned Vendor Bots   │◄───► [OpenAI GPT-4o-mini] (Sales Rep)
       └───────────┬────────────┘
                   │
        Generates Checkout Ref
                   │
                   ▼
       ┌────────────────────────┐
       │   Customer Transfer    │ (to Vendor's Bank Account)
       └───────────┬────────────┘
                   │
       Verifies via Svix Webhook
                   │
                   ▼
       ┌────────────────────────┐
       │ Flutterwave Settlement │ (Wires 95% of Funds to Vendor)
       └────────────────────────┘
```

---

## 2. Core Stack & Dependencies

*   **Runtime**: Node.js (Express framework)
*   **WhatsApp Engine**: `@whiskeysockets/baileys` (runs socket events, message streams, pairing codes)
*   **Database**: MongoDB (`mongoose`) (stores session creds, vendor stores, checkout orders, products, and onboarding states)
*   **AI Engine**: `openai` (GPT-4o-mini for natural conversational logic and Vision API for OCR payment receipt fraud detection)
*   **Payment Gateway**: `Flutterwave` (handles bank lookups and virtual order checkout references)
*   **Webhooks Routing**: `Svix` (verifies webhook signatures and event payloads securely)

---

## 3. Database Schemas (`index.js`)

Naxr uses five primary MongoDB collections:

### A. `Vendor`
Stores active vendor shop data.
```javascript
{
  phoneNumber: String,      // Cleaned phone number (e.g. 23481...)
  jid: String,              // WhatsApp JID string
  storeName: String,        // Name of business
  category: String,         // Fashion, food, gadgets, etc.
  description: String,      // Short business bio used by OpenAI system prompt
  bankDetails: String,      // Human-readable bank name and account
  subaccountCode: String,   // Flutterwave bank code used for wires
  deliveryInfo: String,     // Delivery policies
  faqs: String,             // Answers to regular questions
  docsSent: Boolean,        // Onboarding welcome documents flag
  isPro: Boolean,           // Account billing tier status
  aiActive: Boolean,        // Active AI trigger state
  createdAt: Date
}
```

### C. `Order`
Tracks customer transaction checkouts.
```javascript
{
  vendorPhone: String,
  customerPhone: String,
  productName: String,
  amount: Number,
  virtualAccountNumber: String, // Order reference tracking ID
  txRef: String,                // Unique Flutterwave transaction ref (BOT-...)
  status: String,               // PENDING or PAID
  createdAt: Date
}
```

### D. `Product`
Stores product items with images.
```javascript
{
  vendorPhone: String,
  name: String,
  price: Number,
  imageUrl: String,
  createdAt: Date
}
```

---

## 4. Operational Flows

### A. Onboarding Flow (Master Agent)
1. User messages the master bot with "Register".
2. System initiates a `RegSession` document starting at Step 1.
3. Steps are processed sequentially via `getStepPrompt(step)`:
    - **Step 1**: Store Name.
    - **Step 2**: Store Category.
    - **Step 3**: Store Description.
    - **Step 4**: WhatsApp Phone Number (cleaned automatically).
    - **Step 5**: Payout Details (`Bank Name - Account Number`). Triggers bank lookup via `lookupBankCode()`.
    - **Step 6**: Delivery Instructions.
    - **Step 7**: Product image uploads with pricing tags in captions. Replying `DONE` saves items.
4. Saving triggers WhatsApp device pairing code generation via `spawnVendorAgent(..., requestNewCode: true)`.

### B. Customer-Facing AI Flow (Vendor Agent)
1. Customer sends message to vendor's WhatsApp.
2. System parses "buying intent" words or product names from active catalog items.
3. If intent matches:
    - **Catalog Request**: Sends list of products, images, and prices.
    - **Checkout/Purchase Request**: OpenAI returns a JSON string: `{"action": "BUY", "productName": "Name", "price": 10000}`.
    - Bot saves a `PENDING` order, creates a reference code, and sends bank transfer directions.

### C. Payment Receipt Verification & Fraud Check
Customers can report payment by sending a screenshot of their bank transfer receipt.
1. Vision analysis executes using `gpt-4o-mini` with base64 receipt attachments.
2. The AI checks details:
    - Verifies the receipt is valid and matches the expected amount.
    - Flags suspect pixel manipulation, font mismatches, or generated layouts.
3. OpenAI responds in JSON format: `{"isReceipt": true/false, "isSuspicious": true/false, ...}`.
4. If flagged as suspicious, the system warns the vendor immediately to avoid delivery fraud.

### D. Svix Webhook & Payment Wires
1. Payment completes on Flutterwave.
2. Flutterwave notifies Svix, which signs the payload and hits `/webhook/flutterwave`.
3. System verifies signature using `Webhook(svixSecret).verify()`.
4. Matches the transaction reference prefix `BOT-`. Updates order to `PAID`.
5. Sends notification alerts to customer and vendor.

---

## 5. Admin Self-Chat Commands

Vendors can send messages directly to their own WhatsApp numbers to execute administrative functions:

*   `stats`: Get current paid sales count, pending checkouts, and total revenue.
*   `analytics`: Shows detailed lists of paid orders and pending transactions.
*   `products`: List all items currently available in the store database.
*   `ai off` / `ai on`: Toggle the AI auto-reply feature.
*   `edit description [new description]`: Change the store bio details dynamically.
*   `delete product [name]`: Delete an item from catalog lists.
*   `confirm test`: Confirm a pending test order manually.
*   *Adding items*: Send an image to yourself with `<Name> - ₦<Price>` in the caption to add products instantly.

---

## 6. Environment Configurations (`.env`)

Verify your `.env` contains the following values:

```env
PORT=3000
MONGODB_URI=mongodb+srv://...               # MongoDB Atlas connection string
OPENAI_API_KEY=sk-proj-...                   # OpenAI API Key (requires GPT-4o-mini support)
FLUTTERWAVE_SECRET_KEY=FLWSECK-...         # Flutterwave Secret Key
SVIX_SECRET=whsec_...                       # Svix Webhook Signing Key
```

---

## 7. Developer & Production Run Command

To start the bot server locally:
```bash
npm install
npm start
```
Ensure the global JSON parser in Express is declared *after* raw parser middleware in index.js to prevent Svix signature failures due to parsed body formats:
```javascript
app.post('/webhook/flutterwave', express.raw({ type: 'application/json' }), async (req, res) => { ... });
app.use(express.json()); // Global JSON parser goes here
```

For production, deploy to hosts like Render, Heroku, or AWS, ensuring ports are bound correctly. Graceful shutdowns are configured via `process.on('SIGTERM')` to close active MongoDB connections and cleanly terminate WhatsApp Baileys sockets.
