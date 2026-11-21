// Promote an existing account to admin.
// Admins are never created through public sign-up; run this once with database access:
//   npm run make-admin -- admin@example.com
import "dotenv/config";
import { MongoClient } from "mongodb";

const email = process.argv[2]?.toLowerCase().trim();
if (!email) {
  console.error("Usage: npm run make-admin -- <email>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const users = client.db(process.env.DB_NAME || "pizzahub").collection("users");
  const { matchedCount } = await users.updateOne(
    { email },
    { $set: { role: "admin", isBlocked: false, updatedAt: new Date() } }
  );
  if (!matchedCount) {
    console.error(`No user found with email ${email}. Sign up first, then run this script.`);
    process.exitCode = 1;
  } else {
    console.log(`${email} is now an admin.`);
  }
} finally {
  await client.close();
}
