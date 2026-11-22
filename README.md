# PizzaHub (Server)

This is the backend API for PizzaHub, a pizza ordering and delivery website with Customer, Vendor and Admin roles. It is made with Express and MongoDB. It checks the JWT token from Better Auth and handles the Stripe Premium payment with a webhook.

**Live API:** https://pizzahub-server-umber.vercel.app
**Live site:** https://pizzahub-client-coral.vercel.app
**Client repo:** https://github.com/ssheikhs/pizzahub-client
**Server repo:** https://github.com/ssheikhs/pizzahub-server

## Features

- JWT token check on every private API
- Role check middleware for admin, vendor and customer (401 for not logged in, 403 for wrong role)
- Users can only edit or delete their own data
- Data is validated on the server
- Free vendors can have only 3 active items
- Stripe Checkout for vendor Premium. Premium turns on only after the Stripe webhook is verified
- Subscription cancel, renew and expiry are handled
- Blocked users can't use private APIs
- Admin can only view payment records, not edit them

## Technologies (npm packages)

- express
- mongodb
- jose (JWT verify)
- stripe
- cors
- dotenv
- nodemon (dev)

## Database collections

- `users` (made by Better Auth): name, email, image, role, isBlocked, businessName, subscriptionPlan, subscriptionExpiresAt
- `menuItems`: vendorId, itemName, category, description, price, location, images, status, createdAt
- `orders`: itemId, vendorId, customerId, deliveryDate, deliveryAddress, message, status, createdAt
- `transactions`: vendorId, plan, amount, currency, stripeSessionId, stripeSubscriptionId, status, createdAt

## Environment variables

Make a `.env` file in the root:

```
PORT=
MONGODB_URI=
DB_NAME=
CLIENT_URL=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PREMIUM_PRICE_USD=
```

## How to run locally

```bash
git clone https://github.com/ssheikhs/pizzahub-server.git
cd pizzahub-server
npm install
npm run dev
```

The server runs on http://localhost:5000.

To make an admin account (sign up on the website first):

```bash
npm run make-admin -- your@email.com
```

For Stripe webhook on localhost:

```bash
stripe listen --forward-to localhost:5000/payments/webhook
```

## Main API routes

| Method | Route | Who can use |
| --- | --- | --- |
| GET | `/menu`, `/menu/featured`, `/menu/meta` | Everyone |
| GET | `/menu/:id` | Logged in users |
| GET, PATCH | `/users/me` | Logged in users |
| GET, POST, PATCH, DELETE | `/vendor/menu` | Vendor |
| GET, PATCH | `/vendor/orders` | Vendor |
| POST, GET | `/orders`, `/orders/my` | Customer |
| PATCH | `/orders/:id/cancel` | Customer |
| GET, PATCH, DELETE | `/admin/...` | Admin |
| POST | `/payments/checkout` | Vendor |
| POST | `/payments/webhook` | Stripe |

## How I built the challenge parts

**1. Search and sorting**

`GET /menu` takes these query parameters:

- `search` - searches item name, description and category
- `category` and `location` - filters
- `minPrice` and `maxPrice` - price range
- `sort` - `newest`, `price_asc`, `price_desc` or `name_asc`
- `page` and `limit` - pagination

Only approved items are returned.

**2. JWT verify middleware**

```
request -> verifyToken -> verifyAdmin / verifyVendor / verifyCustomer -> route
```

- `verifyToken` reads the `Bearer` token and checks it with `jose` using the client's public keys (`/api/auth/jwks`). If the token is missing, wrong or expired it sends 401.
- Then it finds the user in MongoDB. A blocked user gets 403.
- `verifyAdmin`, `verifyVendor` and `verifyCustomer` check the role from the database, not from the request. Wrong role gets 403.
- Inside the routes I also check that the item or order belongs to the user before updating or deleting.

**3. Payment security**

The checkout session is made for the logged in vendor only. The success page does not turn on Premium. Premium is turned on only inside the webhook after Stripe's signature is verified.
