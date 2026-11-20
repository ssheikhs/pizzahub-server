import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const app = express();
const port = process.env.PORT || 5000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
const PREMIUM_PRICE = Number(process.env.PREMIUM_PRICE_USD || 9.99);
const FREE_ITEM_LIMIT = 3;

const CATEGORIES = [
    'Classic Pizzas',
    'Vegetarian Pizzas',
    'Meat Lovers',
    'Specialty / Gourmet Pizzas',
    'Sides & Appetizers',
    'Beverages & Desserts',
];
const MENU_STATUSES = ['pending', 'approved', 'rejected', 'inactive'];
const ORDER_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled'];

// middleware
app.use(cors({ origin: [clientUrl, 'http://localhost:3000'], credentials: true }));

app.use(express.json({ limit: '1mb' }));

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log('You successfully connected to MongoDB!');
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db(process.env.DB_NAME || 'pizzahub');
const users = database.collection('users');
const sessions = database.collection('session');
const menuItems = database.collection('menuItems');
const orders = database.collection('orders');
const transactions = database.collection('transactions');

app.get('/', (req, res) => {
    res.send({ name: 'PizzaHub API', status: 'ok' });
});

// ---------- helpers ----------

const isValidId = (id) => typeof id === 'string' && id.length === 24 && ObjectId.isValid(id);

const escapeRegex = (text = '') => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getPaging = (query, defaultLimit = 12) => {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(query.limit) || defaultLimit));
    return { page, limit, skip: (page - 1) * limit };
};

const isText = (value) => typeof value === 'string' && value.trim().length > 0;

// join the vendor's public info onto menu items / orders
const lookupVendor = [
    {
        $lookup: {
            from: 'users',
            localField: 'vendorId',
            foreignField: '_id',
            as: 'vendor',
            pipeline: [{ $project: { name: 1, image: 1, businessName: 1, subscriptionPlan: 1 } }],
        },
    },
    { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
    { $addFields: { isPremiumVendor: { $eq: ['$vendor.subscriptionPlan', 'premium'] } } },
];

const lookupCustomer = [
    {
        $lookup: {
            from: 'users',
            localField: 'customerId',
            foreignField: '_id',
            as: 'customer',
            pipeline: [{ $project: { name: 1, email: 1, image: 1, phone: 1 } }],
        },
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
];

const lookupItem = [
    {
        $lookup: {
            from: 'menuItems',
            localField: 'itemId',
            foreignField: '_id',
            as: 'item',
            pipeline: [{ $project: { itemName: 1, images: 1, price: 1, category: 1, location: 1 } }],
        },
    },
    { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } },
];

// returns { data, errors }
const validateMenuItem = (body, partial = false) => {
    const errors = {};
    const data = {};

    if (!partial || body.itemName !== undefined) {
        const name = isText(body.itemName) ? body.itemName.trim() : '';
        if (name.length < 3 || name.length > 80) errors.itemName = 'Item name must be 3-80 characters';
        else data.itemName = name;
    }
    if (!partial || body.category !== undefined) {
        if (!CATEGORIES.includes(body.category)) errors.category = 'Choose a valid category';
        else data.category = body.category;
    }
    if (!partial || body.description !== undefined) {
        const description = isText(body.description) ? body.description.trim() : '';
        if (description.length < 20 || description.length > 1000) errors.description = 'Description must be 20-1000 characters';
        else data.description = description;
    }
    if (!partial || body.price !== undefined) {
        const price = Number(body.price);
        if (!Number.isFinite(price) || price <= 0 || price > 1000) errors.price = 'Price must be between 0 and 1000';
        else data.price = Math.round(price * 100) / 100;
    }
    if (!partial || body.location !== undefined) {
        if (!isText(body.location) || body.location.length > 80) errors.location = 'Location is required';
        else data.location = body.location.trim();
    }
    if (!partial || body.images !== undefined) {
        const images = Array.isArray(body.images)
            ? body.images.filter((url) => typeof url === 'string' && url.startsWith('https://')).slice(0, 5)
            : [];
        if (!images.length) errors.images = 'At least one uploaded image is required';
        else data.images = images;
    }
    return { data, errors };
};

const validateOrder = (body) => {
    const errors = {};
    const deliveryDate = typeof body.deliveryDate === 'string' ? body.deliveryDate.slice(0, 10) : '';
    const today = new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || isNaN(new Date(deliveryDate).getTime())) {
        errors.deliveryDate = 'Choose a valid delivery date';
    } else if (deliveryDate < today) {
        errors.deliveryDate = 'Delivery date cannot be in the past';
    }
    if (!isText(body.deliveryAddress) || body.deliveryAddress.trim().length < 8) {
        errors.deliveryAddress = 'Enter a full delivery address';
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message.length > 500) errors.message = 'Message must be under 500 characters';

    return {
        data: { deliveryDate, deliveryAddress: body.deliveryAddress?.trim(), message },
        errors,
    };
};

const sendValidationError = (res, errors) => {
    res.status(400).send({ message: 'Please fix the highlighted fields', details: errors });
};

// ---------- auth middleware ----------

// Better Auth (in the Next.js client) signs JWTs and publishes its public keys here.
const JWKS = createRemoteJWKSet(new URL(`${clientUrl}/api/auth/jwks`));

// Verifies the JWT (signature, issuer, audience, expiry) and loads the user
// from the database. The role is never taken from the request.
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }

    let payload;
    try {
        const verified = await jwtVerify(token, JWKS, { issuer: clientUrl, audience: clientUrl });
        payload = verified.payload;
    } catch (err) {
        const message = err.code === 'ERR_JWT_EXPIRED' ? 'Token expired' : 'Invalid token';
        res.status(401).send({ message: `Unauthorized: ${message}` });
        return;
    }

    if (!isValidId(payload.sub)) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }
    const user = await users.findOne({ _id: new ObjectId(payload.sub) });
    if (!user) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }
    if (user.isBlocked) {
        res.status(403).send({ message: 'Your account has been blocked by an admin' });
        return;
    }

    // premium ends automatically when the paid period is over
    if (user.subscriptionPlan === 'premium' && user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) < new Date()) {
        await users.updateOne({ _id: user._id }, { $set: { subscriptionPlan: 'free' } });
        user.subscriptionPlan = 'free';
    }

    req.user = user;
    next();
};

// must call these middlewares after verifyToken
const verifyAdmin = async (req, res, next) => {
    if (req.user.role !== 'admin') {
        res.status(403).send({ message: 'Forbidden' });
        return;
    }
    next();
};

const verifyVendor = async (req, res, next) => {
    if (req.user.role !== 'vendor') {
        res.status(403).send({ message: 'Forbidden' });
        return;
    }
    next();
};

const verifyCustomer = async (req, res, next) => {
    if (req.user.role !== 'customer') {
        res.status(403).send({ message: 'Forbidden' });
        return;
    }
    next();
};

// ---------- users related apis ----------

const publicUser = (user) => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    image: user.image || null,
    role: user.role,
    isBlocked: !!user.isBlocked,
    businessName: user.businessName || '',
    phone: user.phone || '',
    address: user.address || '',
    subscriptionPlan: user.subscriptionPlan || 'free',
    subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    subscriptionCancelAtPeriodEnd: !!user.subscriptionCancelAtPeriodEnd,
    createdAt: user.createdAt,
});

app.get('/users/me', verifyToken, async (req, res) => {
    res.send(publicUser(req.user));
});

// role, isBlocked and subscription fields are never accepted here
app.patch('/users/me', verifyToken, async (req, res) => {
    const body = req.body || {};
    const errors = {};
    const update = {};

    if (body.name !== undefined) {
        if (!isText(body.name) || body.name.trim().length < 2 || body.name.length > 60) errors.name = 'Name must be 2-60 characters';
        else update.name = body.name.trim();
    }
    if (body.image !== undefined) {
        if (!body.image) update.image = null;
        else if (typeof body.image === 'string' && body.image.startsWith('https://')) update.image = body.image;
        else errors.image = 'Image must be an https URL';
    }
    if (body.phone !== undefined) {
        if (body.phone && !/^[+\d\s-]{6,20}$/.test(body.phone)) errors.phone = 'Enter a valid phone number';
        else update.phone = (body.phone || '').trim();
    }
    if (body.address !== undefined) {
        if (typeof body.address !== 'string' || body.address.length > 200) errors.address = 'Address is too long';
        else update.address = body.address.trim();
    }
    if (req.user.role === 'vendor' && body.businessName !== undefined) {
        if (!isText(body.businessName) || body.businessName.length > 80) errors.businessName = 'Restaurant name is required';
        else update.businessName = body.businessName.trim();
    }

    if (Object.keys(errors).length) return sendValidationError(res, errors);
    if (!Object.keys(update).length) return res.status(400).send({ message: 'Nothing to update' });

    const result = await users.findOneAndUpdate(
        { _id: req.user._id },
        { $set: { ...update, updatedAt: new Date() } },
        { returnDocument: 'after' }
    );
    res.send(publicUser(result));
});

// ---------- menu related apis ----------

const SORTS = {
    newest: { createdAt: -1 },
    price_asc: { price: 1, createdAt: -1 },
    price_desc: { price: -1, createdAt: -1 },
    name_asc: { itemName: 1 },
};

// public: search, filter, sort and paginate approved items only
app.get('/menu', async (req, res) => {
    const { search, category, location, minPrice, maxPrice, sort = 'newest' } = req.query;
    const { page, limit, skip } = getPaging(req.query, 12);

    const query = { status: 'approved' };
    if (search?.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), 'i');
        query.$or = [{ itemName: regex }, { description: regex }, { category: regex }];
    }
    if (CATEGORIES.includes(category)) {
        query.category = category;
    }
    if (location?.trim()) {
        query.location = new RegExp(`^${escapeRegex(location.trim())}$`, 'i');
    }
    if (minPrice && Number.isFinite(Number(minPrice))) {
        query.price = { ...query.price, $gte: Number(minPrice) };
    }
    if (maxPrice && Number.isFinite(Number(maxPrice))) {
        query.price = { ...query.price, $lte: Number(maxPrice) };
    }

    const [result] = await menuItems
        .aggregate([
            { $match: query },
            {
                $facet: {
                    items: [{ $sort: SORTS[sort] || SORTS.newest }, { $skip: skip }, { $limit: limit }, ...lookupVendor],
                    total: [{ $count: 'count' }],
                },
            },
        ])
        .toArray();

    const total = result.total[0]?.count || 0;
    res.send({ items: result.items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

// public: premium vendors first, then newest
app.get('/menu/featured', async (req, res) => {
    const result = await menuItems
        .aggregate([{ $match: { status: 'approved' } }, ...lookupVendor, { $sort: { isPremiumVendor: -1, createdAt: -1 } }, { $limit: 8 }])
        .toArray();
    res.send(result);
});

// public: category counts and locations for the filters
app.get('/menu/meta', async (req, res) => {
    const counts = await menuItems
        .aggregate([{ $match: { status: 'approved' } }, { $group: { _id: '$category', count: { $sum: 1 } } }])
        .toArray();
    const locations = await menuItems.distinct('location', { status: 'approved' });
    const countMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));
    res.send({
        categories: CATEGORIES.map((name) => ({ name, count: countMap[name] || 0 })),
        locations: locations.sort(),
    });
});

// private: customers only see approved items, owners and admins can preview any status
app.get('/menu/:id', verifyToken, async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).send({ message: 'Invalid menu item id' });

    const [item] = await menuItems.aggregate([{ $match: { _id: new ObjectId(req.params.id) } }, ...lookupVendor]).toArray();
    if (!item) return res.status(404).send({ message: 'Menu item not found' });

    const isOwner = item.vendorId.equals(req.user._id);
    if (item.status !== 'approved' && !isOwner && req.user.role !== 'admin') {
        return res.status(404).send({ message: 'This menu item is not available' });
    }
    res.send(item);
});

// ---------- vendor related apis ----------

// items waiting for review and live items both use a publishing slot
const ACTIVE_STATUSES = ['pending', 'approved'];

const canPublish = async (vendor, excludeId) => {
    if (vendor.subscriptionPlan === 'premium') return true;
    const query = { vendorId: vendor._id, status: { $in: ACTIVE_STATUSES } };
    if (excludeId) query._id = { $ne: excludeId };
    const active = await menuItems.countDocuments(query);
    return active < FREE_ITEM_LIMIT;
};

const planLimitError = {
    message: `Free plan allows ${FREE_ITEM_LIMIT} active menu items. Upgrade to Premium to publish unlimited items.`,
    code: 'PLAN_LIMIT',
};

// find an item and make sure it belongs to the logged in vendor
const findOwnItem = async (req, res) => {
    if (!isValidId(req.params.id)) {
        res.status(400).send({ message: 'Invalid menu item id' });
        return null;
    }
    const item = await menuItems.findOne({ _id: new ObjectId(req.params.id) });
    if (!item) {
        res.status(404).send({ message: 'Menu item not found' });
        return null;
    }
    if (!item.vendorId.equals(req.user._id)) {
        res.status(403).send({ message: 'You can only manage your own menu items' });
        return null;
    }
    return item;
};

app.get('/vendor/stats', verifyToken, verifyVendor, async (req, res) => {
    const vendorId = req.user._id;
    const itemStatus = await menuItems.aggregate([{ $match: { vendorId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    const orderStatus = await orders.aggregate([{ $match: { vendorId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    const ordersByDay = await orders
        .aggregate([
            { $match: { vendorId, createdAt: { $gte: new Date(Date.now() - 13 * 864e5) } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
        ])
        .toArray();

    const items = Object.fromEntries(itemStatus.map((s) => [s._id, s.count]));
    const ords = Object.fromEntries(orderStatus.map((s) => [s._id, s.count]));
    res.send({
        totalItems: itemStatus.reduce((sum, s) => sum + s.count, 0),
        activeItems: items.approved || 0,
        pendingItems: items.pending || 0,
        pendingOrders: ords.pending || 0,
        acceptedOrders: ords.accepted || 0,
        rejectedOrders: ords.rejected || 0,
        cancelledOrders: ords.cancelled || 0,
        subscriptionPlan: req.user.subscriptionPlan || 'free',
        subscriptionExpiresAt: req.user.subscriptionExpiresAt || null,
        ordersByDay,
    });
});

app.get('/vendor/menu', verifyToken, verifyVendor, async (req, res) => {
    const result = await menuItems.find({ vendorId: req.user._id }).sort({ createdAt: -1 }).toArray();
    res.send(result);
});

// new items always start as pending
app.post('/vendor/menu', verifyToken, verifyVendor, async (req, res) => {
    const { data, errors } = validateMenuItem(req.body || {});
    if (Object.keys(errors).length) return sendValidationError(res, errors);
    if (!(await canPublish(req.user))) return res.status(403).send(planLimitError);

    const item = { ...data, vendorId: req.user._id, status: 'pending', createdAt: new Date(), updatedAt: new Date() };
    const result = await menuItems.insertOne(item);
    res.status(201).send({ ...item, _id: result.insertedId });
});

// edits go back to admin review (paused items stay paused)
app.patch('/vendor/menu/:id', verifyToken, verifyVendor, async (req, res) => {
    const item = await findOwnItem(req, res);
    if (!item) return;

    const { data, errors } = validateMenuItem(req.body || {}, true);
    if (Object.keys(errors).length) return sendValidationError(res, errors);
    if (!Object.keys(data).length) return res.status(400).send({ message: 'Nothing to update' });

    const nextStatus = item.status === 'inactive' ? 'inactive' : 'pending';
    if (nextStatus === 'pending' && !ACTIVE_STATUSES.includes(item.status) && !(await canPublish(req.user, item._id))) {
        return res.status(403).send(planLimitError);
    }

    const result = await menuItems.findOneAndUpdate(
        { _id: item._id },
        { $set: { ...data, status: nextStatus, updatedAt: new Date() } },
        { returnDocument: 'after' }
    );
    res.send(result);
});

// pause an item, or send a paused item back for review
app.patch('/vendor/menu/:id/availability', verifyToken, verifyVendor, async (req, res) => {
    const item = await findOwnItem(req, res);
    if (!item) return;

    if (req.body?.available !== true) {
        if (!ACTIVE_STATUSES.includes(item.status)) return res.status(409).send({ message: 'Only live or pending items can be paused' });
        await menuItems.updateOne({ _id: item._id }, { $set: { status: 'inactive', updatedAt: new Date() } });
        return res.send({ status: 'inactive' });
    }

    if (item.status !== 'inactive') return res.status(409).send({ message: 'Only paused items can be made available again' });
    if (!(await canPublish(req.user, item._id))) return res.status(403).send(planLimitError);
    await menuItems.updateOne({ _id: item._id }, { $set: { status: 'pending', updatedAt: new Date() } });
    res.send({ status: 'pending' });
});

app.delete('/vendor/menu/:id', verifyToken, verifyVendor, async (req, res) => {
    const item = await findOwnItem(req, res);
    if (!item) return;

    const openOrders = await orders.countDocuments({ itemId: item._id, status: { $in: ['pending', 'accepted'] } });
    if (openOrders > 0) {
        return res.status(409).send({ message: 'This item has open orders. Pause it instead, or resolve the orders first.' });
    }
    const result = await menuItems.deleteOne({ _id: item._id });
    res.send(result);
});

app.get('/vendor/orders', verifyToken, verifyVendor, async (req, res) => {
    const query = { vendorId: req.user._id };
    if (ORDER_STATUSES.includes(req.query.status)) query.status = req.query.status;
    const result = await orders.aggregate([{ $match: query }, { $sort: { createdAt: -1 } }, ...lookupItem, ...lookupCustomer]).toArray();
    res.send(result);
});

// accept or reject a pending order (only once)
app.patch('/vendor/orders/:id', verifyToken, verifyVendor, async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).send({ message: 'Invalid order id' });
    const status = req.body?.status;
    if (!['accepted', 'rejected'].includes(status)) return res.status(400).send({ message: 'Status must be accepted or rejected' });

    const _id = new ObjectId(req.params.id);
    const order = await orders.findOne({ _id });
    if (!order) return res.status(404).send({ message: 'Order not found' });
    if (!order.vendorId.equals(req.user._id)) return res.status(403).send({ message: 'This order belongs to another restaurant' });

    const result = await orders.findOneAndUpdate(
        { _id, status: 'pending' },
        {
            $set: { status, updatedAt: new Date() },
            $push: { statusHistory: { status, at: new Date(), by: 'vendor' } },
        },
        { returnDocument: 'after' }
    );
    if (!result) return res.status(409).send({ message: `This order is already ${order.status}` });
    res.send(result);
});

// ---------- orders related apis ----------

app.post('/orders', verifyToken, verifyCustomer, async (req, res) => {
    const body = req.body || {};
    if (!isValidId(body.itemId)) return res.status(400).send({ message: 'Invalid menu item id' });
    const { data, errors } = validateOrder(body);
    if (Object.keys(errors).length) return sendValidationError(res, errors);

    const itemId = new ObjectId(body.itemId);
    const item = await menuItems.findOne({ _id: itemId });
    if (!item) return res.status(404).send({ message: 'Menu item not found' });
    if (item.status !== 'approved') return res.status(409).send({ message: 'This item is not available for ordering right now' });
    if (item.vendorId.equals(req.user._id)) return res.status(403).send({ message: 'You cannot order your own menu item' });

    const duplicate = await orders.findOne({
        itemId,
        customerId: req.user._id,
        deliveryDate: data.deliveryDate,
        status: { $in: ['pending', 'accepted'] },
    });
    if (duplicate) {
        return res.status(409).send({ message: 'You already have an active order for this item on that delivery date' });
    }

    const now = new Date();
    const order = {
        itemId,
        vendorId: item.vendorId,
        customerId: req.user._id,
        ...data,
        price: item.price,
        status: 'pending',
        statusHistory: [{ status: 'pending', at: now, by: 'customer' }],
        createdAt: now,
        updatedAt: now,
    };
    const result = await orders.insertOne(order);
    res.status(201).send({ ...order, _id: result.insertedId });
});

app.get('/orders/my', verifyToken, verifyCustomer, async (req, res) => {
    const query = { customerId: req.user._id };
    if (ORDER_STATUSES.includes(req.query.status)) query.status = req.query.status;
    const result = await orders.aggregate([{ $match: query }, { $sort: { createdAt: -1 } }, ...lookupItem, ...lookupVendor]).toArray();
    res.send(result);
});

app.get('/orders/stats', verifyToken, verifyCustomer, async (req, res) => {
    const grouped = await orders.aggregate([{ $match: { customerId: req.user._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    const spent = await orders
        .aggregate([{ $match: { customerId: req.user._id, status: 'accepted' } }, { $group: { _id: null, total: { $sum: '$price' } } }])
        .toArray();
    const counts = Object.fromEntries(grouped.map((g) => [g._id, g.count]));
    res.send({
        total: grouped.reduce((sum, g) => sum + g.count, 0),
        pending: counts.pending || 0,
        accepted: counts.accepted || 0,
        rejected: counts.rejected || 0,
        cancelled: counts.cancelled || 0,
        acceptedValue: spent[0]?.total || 0,
    });
});

// the customer, the vendor of the order, or an admin
app.get('/orders/:id', verifyToken, async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).send({ message: 'Invalid order id' });
    const [order] = await orders
        .aggregate([{ $match: { _id: new ObjectId(req.params.id) } }, ...lookupItem, ...lookupVendor, ...lookupCustomer])
        .toArray();
    if (!order) return res.status(404).send({ message: 'Order not found' });

    const allowed = order.customerId.equals(req.user._id) || order.vendorId.equals(req.user._id) || req.user.role === 'admin';
    if (!allowed) return res.status(403).send({ message: 'You cannot view this order' });
    res.send(order);
});

// customers can cancel their own pending orders
app.patch('/orders/:id/cancel', verifyToken, verifyCustomer, async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).send({ message: 'Invalid order id' });
    const _id = new ObjectId(req.params.id);
    const order = await orders.findOne({ _id });
    if (!order) return res.status(404).send({ message: 'Order not found' });
    if (!order.customerId.equals(req.user._id)) return res.status(403).send({ message: 'You can only cancel your own orders' });

    const result = await orders.findOneAndUpdate(
        { _id, status: 'pending' },
        {
            $set: { status: 'cancelled', updatedAt: new Date() },
            $push: { statusHistory: { status: 'cancelled', at: new Date(), by: 'customer' } },
        },
        { returnDocument: 'after' }
    );
    if (!result) return res.status(409).send({ message: `Only pending orders can be cancelled. This order is ${order.status}.` });
    res.send(result);
});

// ---------- errors ----------

app.use((req, res) => {
    res.status(404).send({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).send({ message: 'Malformed JSON body' });
    }
    console.log(err);
    res.status(500).send({ message: 'Something went wrong on our side' });
});

if (!process.env.VERCEL) {
    app.listen(port, () => {
        console.log(`PizzaHub server is running on port ${port}`);
    });
}

export default app;
