import { Router } from "express";
import { collections } from "../config/db.js";
import { verifyToken } from "../middleware/auth.js";
import { asyncHandler, escapeRegex, HttpError, parsePaging, toObjectId } from "../utils/http.js";
import { CATEGORIES } from "../utils/validate.js";
import { lookupVendor } from "../utils/pipelines.js";

const router = Router();

const SORTS = {
  newest: { createdAt: -1 },
  price_asc: { price: 1, createdAt: -1 },
  price_desc: { price: -1, createdAt: -1 },
  name_asc: { itemName: 1 },
};

/**
 * GET /api/menu  (public)
 * Query: search, category, location, minPrice, maxPrice, sort, page, limit
 * Only approved items are ever returned here.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { menuItems } = await collections();
    const { search, category, location, minPrice, maxPrice, sort = "newest" } = req.query;
    const { page, limit, skip } = parsePaging(req.query, 12);

    const match = { status: "approved" };
    if (search?.trim()) {
      const rx = new RegExp(escapeRegex(search.trim()), "i");
      match.$or = [{ itemName: rx }, { description: rx }, { category: rx }];
    }
    if (category && CATEGORIES.includes(category)) match.category = category;
    if (location?.trim()) match.location = new RegExp(`^${escapeRegex(location.trim())}$`, "i");
    const min = Number(minPrice);
    const max = Number(maxPrice);
    if (Number.isFinite(min) && minPrice !== "" && minPrice !== undefined) match.price = { ...match.price, $gte: min };
    if (Number.isFinite(max) && maxPrice !== "" && maxPrice !== undefined) match.price = { ...match.price, $lte: max };

    const [result] = await menuItems
      .aggregate([
        { $match: match },
        {
          $facet: {
            items: [{ $sort: SORTS[sort] || SORTS.newest }, { $skip: skip }, { $limit: limit }, ...lookupVendor],
            total: [{ $count: "count" }],
          },
        },
      ])
      .toArray();

    const total = result.total[0]?.count || 0;
    res.json({ items: result.items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  })
);

// GET /api/menu/featured (public) - premium vendors first, then newest
router.get(
  "/featured",
  asyncHandler(async (req, res) => {
    const { menuItems } = await collections();
    const items = await menuItems
      .aggregate([
        { $match: { status: "approved" } },
        ...lookupVendor,
        { $sort: { isPremiumVendor: -1, createdAt: -1 } },
        { $limit: 8 },
      ])
      .toArray();
    res.json(items);
  })
);

// GET /api/menu/meta (public) - categories with counts + distinct locations
router.get(
  "/meta",
  asyncHandler(async (req, res) => {
    const { menuItems } = await collections();
    const [counts, locations] = await Promise.all([
      menuItems.aggregate([{ $match: { status: "approved" } }, { $group: { _id: "$category", count: { $sum: 1 } } }]).toArray(),
      menuItems.distinct("location", { status: "approved" }),
    ]);
    const map = Object.fromEntries(counts.map((c) => [c._id, c.count]));
    res.json({
      categories: CATEGORIES.map((name) => ({ name, count: map[name] || 0 })),
      locations: locations.sort((a, b) => a.localeCompare(b)),
    });
  })
);

/**
 * GET /api/menu/:id (private - item details page)
 * Customers see only approved items. The owning vendor and admins can preview other statuses.
 */
router.get(
  "/:id",
  verifyToken,
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id, "menu item id");
    const { menuItems } = await collections();
    const [item] = await menuItems.aggregate([{ $match: { _id } }, ...lookupVendor]).toArray();
    if (!item) throw new HttpError(404, "Menu item not found");

    const isOwner = String(item.vendorId) === req.user.id;
    if (item.status !== "approved" && !isOwner && req.user.role !== "admin") {
      throw new HttpError(404, "This menu item is not available");
    }
    res.json(item);
  })
);

export default router;
