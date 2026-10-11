require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = mongoose.connection.collection('users');
  for await (const u of users.find({})) {
    const lower = u.email.toLowerCase();
    if (lower !== u.email) await users.updateOne({ _id: u._id }, { $set: { email: lower } });
  }
  process.exit(0);
})();