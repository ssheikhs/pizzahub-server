// Shared aggregation stages.

export const vendorPublicProjection = {
  _id: 1,
  name: 1,
  image: 1,
  businessName: 1,
  subscriptionPlan: 1,
};

export const lookupVendor = [
  {
    $lookup: {
      from: "users",
      localField: "vendorId",
      foreignField: "_id",
      as: "vendor",
      pipeline: [{ $project: vendorPublicProjection }],
    },
  },
  { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
  { $addFields: { isPremiumVendor: { $eq: ["$vendor.subscriptionPlan", "premium"] } } },
];

export const lookupCustomer = [
  {
    $lookup: {
      from: "users",
      localField: "customerId",
      foreignField: "_id",
      as: "customer",
      pipeline: [{ $project: { name: 1, email: 1, image: 1, phone: 1 } }],
    },
  },
  { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
];

export const lookupItem = [
  {
    $lookup: {
      from: "menuItems",
      localField: "itemId",
      foreignField: "_id",
      as: "item",
      pipeline: [{ $project: { itemName: 1, images: 1, price: 1, category: 1, location: 1 } }],
    },
  },
  { $unwind: { path: "$item", preserveNullAndEmptyArrays: true } },
];
