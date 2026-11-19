import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { collections } from "../config/db.js";

const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");

// Better Auth (running in the Next.js client) signs JWTs and publishes its
// public keys at /api/auth/jwks. We verify signature, issuer, audience and expiry.
const JWKS = createRemoteJWKSet(new URL(`${clientUrl}/api/auth/jwks`), {
  cacheMaxAge: 10 * 60 * 1000,
});

function userIdFilter(id) {
  return ObjectId.isValid(id) && String(id).length === 24 ? { _id: new ObjectId(id) } : { _id: id };
}

/**
 * verifyToken: requires "Authorization: Bearer <jwt>".
 * 401 when missing/invalid/expired. 403 when the account is blocked.
 * The user (and role) are always loaded from the database, never from the request body.
 */
export async function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Unauthorized: missing token" });
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, JWKS, { issuer: clientUrl, audience: clientUrl }));
  } catch (err) {
    const expired = err?.code === "ERR_JWT_EXPIRED";
    return res.status(401).json({ message: expired ? "Unauthorized: token expired" : "Unauthorized: invalid token" });
  }

  try {
    const { users } = await collections();
    const user = await users.findOne(userIdFilter(payload.sub));
    if (!user) return res.status(401).json({ message: "Unauthorized: user not found" });
    if (user.isBlocked) return res.status(403).json({ message: "Your account has been blocked by an admin" });

    // Expire premium automatically when the paid period has ended.
    if (user.subscriptionPlan === "premium" && user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) < new Date()) {
      await users.updateOne({ _id: user._id }, { $set: { subscriptionPlan: "free" } });
      user.subscriptionPlan = "free";
    }

    req.user = { ...user, id: String(user._id) };
    next();
  } catch (err) {
    next(err);
  }
}

// Role middlewares: always use after verifyToken.
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden: you do not have access to this resource" });
  }
  next();
};

export const verifyAdmin = requireRole("admin");
export const verifyVendor = requireRole("vendor");
export const verifyCustomer = requireRole("customer");
