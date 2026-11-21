# PizzaHub — Server

The REST API for **PizzaHub**, a pizza ordering and delivery platform with Customer, Vendor and Admin roles. It's built with Express and MongoDB, verifies JWTs issued by Better Auth (running in the Next.js client), and handles Stripe subscription payments through webhooks.

- **Live API:** _add your Vercel server URL here_
- **Live site:** _add your Vercel client URL here_
- **Client repository:** https://github.com/ssheikhs/pizzahub-client
- **Server repository:** https://github.com/ssheikhs/pizzahub-server

## Important features

- JWT verification against Better Auth's JWKS (signature, issuer, audience, expiry)
- Role middleware for admin, vendor and customer. Returns 401 for unauthorized and 403 for forbidden requests.
- Ownership checks before every update or delete
- Server-side validation for menu items, orders and profiles
- Free plan limit (3 active items) enforced on the server
- Stripe Checkout subscriptions. Premium is activated only from a signature-verified webhook, and the webhook handling is idempotent.
- Handles subscription renewal, cancellation (at period end) and expiry
- Blocked users are rejected on every protected route and signed out of all sessions
- Payment records are read-only for admins (no update/delete routes)

## Technology stack

| Package | Used for |
| --- | --- |
| `express` 5 | HTTP server |
| `mongodb` | Database driver |
| `jose` | JWT / JWKS verification |
| `stripe` | Checkout sessions and webhooks |
| `cors` | Cross-origin access for the client |
| `dotenv` | Environment variables |
| `nodemon` (dev) | Auto-reload in development |

## Project structure

All routes live in `index.js`, grouped by section: helpers, auth middleware, then users, menu, vendor, orders, admin and payments APIs. `scripts/make-admin.js` promotes an account to admin.

## Database collections

Better Auth manages its own auth collections (`users`, `session`, `account`, `verification`, `jwks`). The business data lives in:

| Collection | Fields |
| --- | --- |
| `users` (Better Auth) | name, email, image, role, isBlocked, businessName, subscriptionPlan, subscriptionExpiresAt |
| `menuItems` | vendorId → users, itemName, category, description, price, location, images, status, createdAt |
| `orders` | itemId → menuItems, vendorId → users, customerId → users, deliveryDate, deliveryAddress, message, status, statusHistory, createdAt |
| `transactions` | vendorId → users, plan, amount, currency, stripeSessionId, stripeSubscriptionId, status, createdAt |

## Environment variables

Create `.env` (see `.env.example`). Never commit it.

```
PORT=5000
MONGODB_URI=               # same database the client uses
DB_NAME=pizzahub
CLIENT_URL=                # client URL, no trailing slash (JWT issuer/audience + CORS)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PREMIUM_PRICE_USD=9.99
```

## Run locally

```bash
git clone https://github.com/ssheikhs/pizzahub-server.git
cd pizzahub-server
npm install
cp .env.example .env    # then fill in the values
npm run dev             # http://localhost:5000
```

To receive Stripe webhooks locally:

```bash
stripe listen --forward-to localhost:5000/payments/webhook
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET
```

Useful scripts:

```bash
npm run make-admin -- admin@example.com     # promote an existing account to admin
```

## Deployment (Vercel)

1. Deploy with the included `vercel.json` and add the environment variables.
2. In the Stripe Dashboard → Webhooks, add `https://<server-url>/payments/webhook` and select these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Set `CLIENT_URL` to the exact deployed client URL.

## API overview

| Method | Route | Access |
| --- | --- | --- |
| GET | `/menu` | Public (search/filter/sort/paginate, approved only) |
| GET | `/menu/featured`, `/menu/meta` | Public |
| GET | `/menu/:id` | Logged in |
| GET/POST | `/vendor/menu` | Vendor |
| PATCH/DELETE | `/vendor/menu/:id` | Vendor (owner) |
| PATCH | `/vendor/menu/:id/availability` | Vendor (owner) |
| GET | `/vendor/orders`, `/vendor/stats` | Vendor |
| PATCH | `/vendor/orders/:id` | Vendor (owner, pending only) |
| POST | `/orders` | Customer |
| GET | `/orders/my`, `/orders/stats` | Customer |
| GET | `/orders/:id` | Order's customer, vendor or admin |
| PATCH | `/orders/:id/cancel` | Customer (owner, pending only) |
| GET/PATCH | `/users/me` | Logged in |
| GET | `/admin/stats`, `/admin/users`, `/admin/menu`, `/admin/transactions` | Admin |
| PATCH | `/admin/users/:id/block`, `/admin/menu/:id/status` | Admin |
| DELETE | `/admin/menu/:id` | Admin |
| POST | `/payments/checkout`, `/payments/cancel` | Vendor |
| GET | `/payments/session/:id`, `/payments/my` | Vendor |
| POST | `/payments/webhook` | Stripe (signature verified) |

## How the challenge requirements were built

### 1. Advanced search and sorting

`GET /menu` accepts these query parameters:

| Param | Effect |
| --- | --- |
| `search` | Case-insensitive regex (user input escaped) on `itemName`, `description`, `category` |
| `category` | Exact category match (validated against the 6 categories) |
| `location` | Exact, case-insensitive location match |
| `minPrice`, `maxPrice` | `$gte` / `$lte` on `price` |
| `sort` | `newest` (default), `price_asc`, `price_desc`, `name_asc` |
| `page`, `limit` | Pagination (limit capped at 50) |

It runs as one aggregation with `$facet`: one branch for the sorted page of items with vendor info joined in, and one for the total count. `status: "approved"` is always part of the match.

### 2. JWT verification middleware

```
request → verifyToken → requireRole(...) → ownership check in handler → response
```

1. **`verifyToken`** (in `index.js`) reads `Authorization: Bearer <token>` and runs `jose.jwtVerify` against the client's JWKS (`CLIENT_URL/api/auth/jwks`, cached). It checks the signature, `iss`, `aud` and `exp`.
   - A missing, invalid or expired token returns **401**.
   - It then loads the user from MongoDB using the token's `sub`. A missing user returns **401** and a blocked user returns **403**.
   - An expired Premium plan is switched back to Free here.
2. **`verifyAdmin` / `verifyVendor` / `verifyCustomer`** compare the role stored in the database (never the token or request body) and return **403** on mismatch.
3. **Handlers** check ownership (e.g. `order.vendorId === req.user._id`) before any update or delete. State changes are atomic, e.g. `findOneAndUpdate({ _id, status: "pending" })`, so an order can only be accepted, rejected or cancelled once.

### Payment security

- The Checkout Session is created for `req.user` from the token, so a user can't open one for another vendor.
- The success page only reads the transaction status. **Premium is activated only in the webhook** after `stripe.webhooks.constructEvent` verifies the signature and `payment_status === "paid"`.
- The webhook update is guarded with `status: { $ne: "paid" }`, so a retried event can't apply twice.
