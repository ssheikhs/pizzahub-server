import { HttpError } from "./http.js";

export const CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];

export const MENU_STATUSES = ["pending", "approved", "rejected", "inactive"];
export const ORDER_STATUSES = ["pending", "accepted", "rejected", "cancelled"];

const isNonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

function cleanImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((u) => typeof u === "string" && /^https:\/\//.test(u.trim()))
    .map((u) => u.trim())
    .slice(0, 5);
}

export function validateMenuItem(body, { partial = false } = {}) {
  const errors = {};
  const out = {};

  if (!partial || body.itemName !== undefined) {
    if (!isNonEmpty(body.itemName) || body.itemName.trim().length < 3 || body.itemName.trim().length > 80)
      errors.itemName = "Item name must be 3-80 characters";
    else out.itemName = body.itemName.trim();
  }
  if (!partial || body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) errors.category = "Choose a valid category";
    else out.category = body.category;
  }
  if (!partial || body.description !== undefined) {
    if (!isNonEmpty(body.description) || body.description.trim().length < 20 || body.description.trim().length > 1000)
      errors.description = "Description must be 20-1000 characters";
    else out.description = body.description.trim();
  }
  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0 || price > 1000) errors.price = "Price must be between 0 and 1000";
    else out.price = Math.round(price * 100) / 100;
  }
  if (!partial || body.location !== undefined) {
    if (!isNonEmpty(body.location) || body.location.trim().length > 80) errors.location = "Location is required";
    else out.location = body.location.trim();
  }
  if (!partial || body.images !== undefined) {
    const images = cleanImages(body.images);
    if (images.length === 0) errors.images = "At least one uploaded image is required";
    else out.images = images;
  }

  if (Object.keys(errors).length) throw new HttpError(400, "Please fix the highlighted fields", errors);
  return out;
}

export function validateOrder(body) {
  const errors = {};
  const date = typeof body.deliveryDate === "string" ? body.deliveryDate.slice(0, 10) : "";
  const parsed = new Date(`${date}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()))
    errors.deliveryDate = "Choose a valid delivery date";
  else if (parsed < today) errors.deliveryDate = "Delivery date cannot be in the past";

  if (!isNonEmpty(body.deliveryAddress) || body.deliveryAddress.trim().length < 8)
    errors.deliveryAddress = "Enter a full delivery address";

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length > 500) errors.message = "Message must be under 500 characters";

  if (Object.keys(errors).length) throw new HttpError(400, "Please fix the highlighted fields", errors);
  return { deliveryDate: date, deliveryAddress: body.deliveryAddress.trim(), message };
}

export function validateProfile(body, role) {
  const errors = {};
  const out = {};
  if (body.name !== undefined) {
    if (!isNonEmpty(body.name) || body.name.trim().length < 2 || body.name.trim().length > 60)
      errors.name = "Name must be 2-60 characters";
    else out.name = body.name.trim();
  }
  if (body.image !== undefined) {
    if (body.image === "" || body.image === null) out.image = null;
    else if (typeof body.image === "string" && /^https:\/\//.test(body.image)) out.image = body.image;
    else errors.image = "Image must be an https URL";
  }
  if (body.phone !== undefined) {
    if (body.phone && !/^[+\d\s-]{6,20}$/.test(body.phone)) errors.phone = "Enter a valid phone number";
    else out.phone = (body.phone || "").trim();
  }
  if (body.address !== undefined) {
    if (typeof body.address !== "string" || body.address.length > 200) errors.address = "Address is too long";
    else out.address = body.address.trim();
  }
  if (role === "vendor" && body.businessName !== undefined) {
    if (!isNonEmpty(body.businessName) || body.businessName.trim().length > 80)
      errors.businessName = "Restaurant name is required";
    else out.businessName = body.businessName.trim();
  }
  if (Object.keys(errors).length) throw new HttpError(400, "Please fix the highlighted fields", errors);
  if (!Object.keys(out).length) throw new HttpError(400, "Nothing to update");
  return out;
}
