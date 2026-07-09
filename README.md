# Cha-Ching

A Cloudflare Worker that receives [App Store Server Notifications V2](https://developer.apple.com/documentation/AppStoreServerNotifications/App-Store-Server-Notifications-V2) and posts formatted messages to Slack.

```
Apple App Store ──(HTTPS POST, signed JWT)──> Cloudflare Worker ──(Slack Webhook)──> #cha-ching
```

## Setup

1. **Create a Slack incoming webhook** for your `#cha-ching` channel at [api.slack.com/apps](https://api.slack.com/apps)

2. **Clone and deploy:**
   ```sh
   git clone <repo-url> && cd cha-ching
   wrangler secret put SLACK_WEBHOOK_URL   # paste your webhook URL
   wrangler deploy
   ```

3. **Configure App Store Connect:**
   - Go to your app → App Information → App Store Server Notifications
   - Set **Production Server URL** to your worker URL (e.g., `https://cha-ching.<your-subdomain>.workers.dev`)
   - Set **Sandbox Server URL** to the same URL
   - Select **Version 2 Notifications**
   - Make a sandbox purchase to verify notifications arrive in Slack

## Local Development

Create a `.dev.vars` file with your Slack webhook URL:

```sh
echo 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL' > .dev.vars
npx wrangler dev
```

### Test with curl

Build a mock JWS payload (header.payload.signature — only the payload matters since we decode without verification):

```sh
# Encode a test payload
PAYLOAD=$(echo -n '{"notificationType":"ONE_TIME_CHARGE","subtype":null,"data":{"environment":"Sandbox","signedTransactionInfo":"eyJ0eXAiOiJKV1QifQ.'$(echo -n '{"bundleId":"co.dgrlabs.cdwally","productId":"cd_wally_unlock","transactionId":"2000000123456789","price":2990,"currency":"USD","storefront":"USA"}' | base64 | tr '+/' '-_' | tr -d '=')'.fakesig"}}' )

# Send it (wrap the signedPayload as a JWS)
SIGNED=$(echo -n '{"typ":"JWT"}' | base64 | tr '+/' '-_' | tr -d '=')
BODY=$(echo -n '{"notificationType":"ONE_TIME_CHARGE","data":{"environment":"Sandbox","signedTransactionInfo":"eyJ0eXAiOiJKV1QifQ.'$(echo -n '{"bundleId":"co.dgrlabs.cdwally","productId":"cd_wally_unlock","transactionId":"2000000123456789","price":2990,"currency":"USD","storefront":"USA"}' | base64 | tr '+/' '-_' | tr -d '=')'.fakesig"}}' | base64 | tr '+/' '-_' | tr -d '=')

curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d "{\"signedPayload\":\"${SIGNED}.${BODY}.fakesig\"}"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL (set via `wrangler secret put`) |

## Notification Types

**Revenue events** (green, 💰): `SUBSCRIBED`, `DID_RENEW`, `OFFER_REDEEMED`, `ONE_TIME_CHARGE`

**Refund events** (red, ⚠️): `REFUND`, `REFUND_REVERSED`

**Informational events** (gray, ℹ️): everything else (renewal changes, expiry, billing failures, etc.)

Sandbox notifications are dropped and never posted to Slack (the worker still returns 200 to Apple). Any that slip through the environment check would be tagged `[SANDBOX]`.
