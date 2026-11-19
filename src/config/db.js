import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("MONGODB_URI is not set");
}

// Reuse one client across serverless invocations on Vercel.
// Connect lazily and allow a retry if the first attempt fails.
function connect() {
  if (!globalThis.__pizzahubMongo) {
    const client = new MongoClient(uri, { maxPoolSize: 10 });
    globalThis.__pizzahubMongo = client.connect().catch((err) => {
      globalThis.__pizzahubMongo = null;
      throw err;
    });
  }
  return globalThis.__pizzahubMongo;
}

let indexesReady = false;

export async function getDb() {
  const client = await connect();
  const db = client.db(process.env.DB_NAME || "pizzahub");
  if (!indexesReady) {
    indexesReady = true;
    await Promise.all([
      db.collection("menuItems").createIndex({ status: 1, category: 1 }),
      db.collection("menuItems").createIndex({ vendorId: 1 }),
      db.collection("orders").createIndex({ customerId: 1, createdAt: -1 }),
      db.collection("orders").createIndex({ vendorId: 1, createdAt: -1 }),
      db.collection("transactions").createIndex({ stripeSessionId: 1 }, { unique: true }),
    ]).catch((err) => console.error("Index creation failed:", err.message));
  }
  return db;
}

export async function collections() {
  const db = await getDb();
  return {
    users: db.collection("users"),
    menuItems: db.collection("menuItems"),
    orders: db.collection("orders"),
    transactions: db.collection("transactions"),
  };
}
