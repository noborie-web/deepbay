This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

### Environment variables

Copy `.env.example` to `.env.local` for local development. Configure the same
variables in the Vercel project for Production before deploying. Never commit
real secret values.

Required for login and database-backed features:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Required for eBay OAuth, token refresh, inventory sync, and inventory actions:

```text
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_REDIRECT_URI_NAME=
EBAY_TOKEN_ENCRYPTION_KEY=
```

`EBAY_TOKEN_ENCRYPTION_KEY` must be a Base64-encoded 32-byte key. Keep the
same value after OAuth tokens are stored; changing it makes existing encrypted
refresh tokens unreadable.

Required for the scheduled inventory job in `vercel.json`:

```text
CRON_SECRET=
```

Optional title translation:

```text
OPENAI_API_KEY=
```

When `OPENAI_API_KEY` is omitted, extraction continues using the original
titles. Vercel provides `NODE_ENV` automatically; do not add it manually.

Before enabling eBay connection, configure the eBay RuName callback for the
production domain as documented below and apply all Supabase migrations.

## eBay account and business-policy sync

The listing flow can connect an existing DeepBay seller to eBay OAuth and load
the seller's fulfillment, payment, and return business policies from the eBay
Account API.

Required server-side environment variables:

```text
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_REDIRECT_URI_NAME=
EBAY_TOKEN_ENCRYPTION_KEY=
```

- `EBAY_REDIRECT_URI_NAME` is the eBay RuName configured for the callback URL
  `https://<deployment-domain>/api/ebay/oauth/callback`.
- `EBAY_TOKEN_ENCRYPTION_KEY` must be a Base64-encoded 32-byte key.
- Apply `supabase/migrations/20260726_ebay_oauth_policy_sync.sql` before enabling
  the connection button.
- The OAuth flow requests only the identity and read-only Account API scopes
  needed to identify the seller and read business policies.
- Refresh tokens are encrypted with AES-256-GCM and stored in a service-role-only
  table. They are never returned to the browser.

<!-- last-deploy: 2026-08-08b -->
