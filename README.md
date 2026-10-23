# School WhatsApp Gateway

One running instance serves **every school**. Each school links its
**own** WhatsApp number (QR scan from inside its own school app) and
sends from that number — receipts, fee reminders, absence alerts and
announcements never mix between schools.

## Run it (Coolify, like the other bots)

1. Put this folder in a GitHub repo and create a Coolify app from it
   (Node.js, `npm install`, `npm start`).
2. Environment variables:
   - `GATEWAY_API_KEY` — a long random secret only you (platform
     owner) know. Used once per school, to register it.
   - `PORT=3000`
3. Mount a persistent volume at `/data` — linked sessions live there;
   without it, every redeploy unlinks every school.
4. Give it a domain, e.g. `wa-schools.your-domain.com`.

## Register a school (platform owner, once per school)

No terminal needed — use **hoppscotch.io** in the browser:

1. Method **POST**, address: `https://wa-schools.your-domain.com/schools`
2. **Headers** tab: add `x-api-key` = your `GATEWAY_API_KEY`.
3. **Body** tab (JSON): `{"schoolId":"love-academy"}` — a short slug
   (lowercase letters, numbers, dashes); each school gets its own.
4. **Send**. The response is `{ "schoolId": "love-academy", "secret": "…" }`.

(Terminal equivalent, if you ever have one:
`curl -X POST …/schools -H "x-api-key: …" -d '{"schoolId":"love-academy"}'`.)

Put these in
**that school's** Apps Script project (Project Settings → Script
Properties):

| Property | Value |
|---|---|
| `WA_GATEWAY_URL` | `https://wa-schools.your-domain.com` |
| `WA_SCHOOL_ID` | `love-academy` |
| `WA_SCHOOL_SECRET` | the secret from the curl response |

Then the school's admin opens **WhatsApp** in their school app and
scans the QR with the school's WhatsApp number. Done — the number
stays linked across restarts.

## Notes

- Unofficial WhatsApp Web automation (Baileys): a number can be
  restricted if it blasts strangers. The school app paces sends
  (2.5–5s apart, max 40 per run) and parents are existing contacts
  of the school — still, tell schools to use a **dedicated school
  number**, not a personal one.
- The gateway never stores message content; the school's own
  WhatsAppLog sheet records what was sent.
- If a school changes numbers: their admin taps **Disconnect** in
  the app, then links the new number.
