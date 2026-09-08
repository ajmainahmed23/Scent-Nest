#!/usr/bin/env node
/**
 * Promotes an account to admin, or creates one.
 *   node scripts/create-admin.js owner@scentnest.com "Ajmain Ahmed" 01712345678 MyPassword123
 */
/* Reads .env sitting next to this file — no dotenv dependency needed. */
(function () {
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
})();

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const [email, name, phone, password] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/create-admin.js <email> [name] [phone] [password]');
  process.exit(1);
}

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const users = client.db(process.env.MONGODB_DB || 'scentnest').collection('users');

  const existing = await users.findOne({ email: email.toLowerCase() });
  if (existing) {
    await users.updateOne({ _id: existing._id }, { $set: { role: 'admin' } });
    console.log(`${email} is now an admin.`);
  } else {
    if (!password) {
      console.error('That account does not exist yet — pass a name, phone and password to create it.');
      process.exit(1);
    }
    await users.insertOne({
      name: name || 'Store Owner',
      email: email.toLowerCase(),
      phone: phone || '',
      password_hash: await bcrypt.hash(password, 10),
      role: 'admin',
      address: '',
      wishlist: [],
      created_at: new Date(),
    });
    console.log(`Admin account created for ${email}.`);
  }
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
