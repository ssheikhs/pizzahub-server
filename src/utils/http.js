import { ObjectId } from "mongodb";

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Wrap async route handlers so thrown errors reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function toObjectId(id, label = "id") {
  if (typeof id !== "string" || !ObjectId.isValid(id) || id.length !== 24) {
    throw new HttpError(400, `Invalid ${label}`);
  }
  return new ObjectId(id);
}

export function parsePaging(query, defaultLimit = 12, maxLimit = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function escapeRegex(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
