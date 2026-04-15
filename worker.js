/**
 * Cloudflare Worker — Landing Page Form Handler
 *
 * Receives POST with { name, email } from simonpowellcoaching.com lead form.
 * 1. Creates a lead in Notion Leads DB (source = Landing Page)
 * 2. Sends Telegram alert to Simon via bot API
 * 3. Adds contact to Brevo (for unsubscribe management)
 * 4. Sends Email 1 ("the gym bag trick") immediately via Brevo transactional API
 *
 * Environment variables (set in Cloudflare dashboard):
 *   NOTION_TOKEN        — Notion integration token
 *   TELEGRAM_BOT_TOKEN  — @simonjrbot bot token
 *   TELEGRAM_CHAT_ID    — Simon's chat ID (8690381480)
 *   BREVO_API_KEY       — Brevo API key
 *   BREVO_LIST_ID       — Brevo contact list ID
 *
 * Deploy: wrangler deploy
 * Test:   wrangler dev
 */

const LEADS_DB = '2999f5f9-2da6-8083-89fb-d799db6fb0e9';
const ALLOWED_ORIGINS = [
  'https://simonpowellcoaching.com',
  'https://simonpowellcoaching.pages.dev',
];

// Rate limiting: max 10 submissions per IP per hour
const RATE_LIMIT = 10;
const RATE_WINDOW = 3600; // seconds

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(request, new Response(null, { status: 204 }));
    }

    if (request.method !== 'POST') {
      return corsResponse(request, new Response('Method not allowed', { status: 405 }));
    }

    // Rate limiting via Cloudflare KV (if bound) or skip
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.RATE_LIMIT_KV) {
      const key = `rate:${clientIP}`;
      const count = parseInt(await env.RATE_LIMIT_KV.get(key) || '0');
      if (count >= RATE_LIMIT) {
        return corsResponse(request, new Response('Too many submissions. Try again later.', { status: 429 }));
      }
      ctx.waitUntil(env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: RATE_WINDOW }));
    }

    // Parse body
    let data;
    try {
      data = await request.json();
    } catch {
      return corsResponse(request, new Response('Invalid request body', { status: 400 }));
    }

    const { name, email } = data;
    if (!name || !email) {
      return corsResponse(request, new Response('Name and email are required', { status: 400 }));
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return corsResponse(request, new Response('Invalid email address', { status: 400 }));
    }

    const cleanName = stripTags(name).slice(0, 200);
    const cleanEmail = stripTags(email).slice(0, 200);

    // Run all four operations concurrently — each is independent
    // If one fails, the others still succeed
    const results = await Promise.allSettled([
      createNotionLead(env, cleanName, cleanEmail),
      sendTelegramAlert(env, cleanName, cleanEmail),
      addToBrevo(env, cleanName, cleanEmail),
      sendWelcomeEmail(env, cleanName, cleanEmail),
    ]);

    // Log failures but don't fail the request
    const errors = [];
    if (results[0].status === 'rejected') errors.push(`Notion: ${results[0].reason}`);
    if (results[1].status === 'rejected') errors.push(`Telegram: ${results[1].reason}`);
    if (results[2].status === 'rejected') errors.push(`Brevo contact: ${results[2].reason}`);
    if (results[3].status === 'rejected') errors.push(`Welcome email: ${results[3].reason}`);

    if (errors.length > 0) {
      console.error('Partial failures:', errors.join('; '));
    }

    // Always return success to the user (their data was received)
    return corsResponse(request, new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  },
};

// ── Notion ──

async function createNotionLead(env, name, email) {
  const now = new Date().toISOString();
  // Next email (Email 2) sends on Day 3
  const nextEmailDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { database_id: LEADS_DB },
      properties: {
        'Name': { title: [{ text: { content: name } }] },
        'Email': { email: email },
        'Status': { select: { name: 'New' } },
        'Source': { relation: [{ id: '2999f5f9-2da6-804a-8f2e-df7e04599cb5' }] },
        'Date Entered': { date: { start: now } },
        'email_sequence_step': { number: 1 },
        'next_email_date': { date: { start: nextEmailDate } },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

// ── Telegram ──

async function sendTelegramAlert(env, name, email) {
  const message = `New lead from landing page: ${name} — ${email}`;

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

// ── Brevo ──

async function addToBrevo(env, name, email) {
  if (!env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY not set');
  }

  const listId = parseInt(env.BREVO_LIST_ID || '0');

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email,
      attributes: {
        FIRSTNAME: name,
      },
      listIds: listId ? [listId] : [],
      updateEnabled: true,
    }),
  });

  // 201 = created, 204 = already exists (updated)
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

// ── Welcome Email (Email 1) ──

async function sendWelcomeEmail(env, name, email) {
  if (!env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY not set');
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Simon Powell', email: 'simonpowell.coach@gmail.com' },
      to: [{ email: email, name: name }],
      subject: 'the gym bag trick',
      htmlContent: getEmail1Html(name),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

function getEmail1Html(firstName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>the gym bag trick</title>
<!--[if mso]>
<style>* { font-family: Arial, sans-serif !important; }</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#F6F9FC;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F6F9FC;">
<tr><td align="center" style="padding:32px 16px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:8px;overflow:hidden;">

  <tr>
    <td align="center" style="padding:32px 40px 24px;">
      <img src="https://simonpowellcoaching.pages.dev/email-header-600.png" width="400" alt="Simon Powell — Strength / Habits / Longevity" style="display:block;max-width:400px;width:100%;height:auto;border:0;">
    </td>
  </tr>

  <tr>
    <td style="padding:0 40px 40px;">

      <p style="margin:0 0 20px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1A1A1A;">
        Hey ${escapeHtml(firstName)},
      </p>

      <p style="margin:0 0 20px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1A1A1A;">
        Simon here. I&#8217;m a fitness coach, which I realise is a profession with a reputation. I promise I&#8217;m not going to tell you to wake up at 5am, drink celery juice, or call you &#8220;warrior.&#8221; I&#8217;m just a bloke from Salford who reads too many research papers at 1am on a Wednesday.
      </p>

      <p style="margin:0 0 20px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1A1A1A;">
        Here&#8217;s what I won&#8217;t do: send you a 12-week transformation plan, a motivational quote, or anything with the word &#8220;journey&#8221; in it.
      </p>

      <p style="margin:0 0 20px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1A1A1A;">
        Here&#8217;s what I will do: share the stuff I&#8217;ve learned from coaching real people through the bit that actually matters. Not the training. The bit before the training. The bit where your brain talks you out of going.
      </p>

      <p style="margin:0 0 20px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1A1A1A;">
        In a couple of days I&#8217;m going to tell you about a client who packed his gym bag every night for three weeks and never once opened it. What happened on week four is the reason I do this job.
      </p>

      <p style="margin:0;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1A1A1A;">
        Keep an eye out.
      </p>

    </td>
  </tr>

  <tr>
    <td style="padding:0 40px;">
      <div style="height:1px;background-color:#E5E7EB;"></div>
    </td>
  </tr>

  <tr>
    <td style="padding:24px 40px 32px;">
      <p style="margin:0 0 8px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#6B7280;">
        Simon Powell Coaching &middot; Salford, UK
      </p>
      <p style="margin:0;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#6B7280;">
        <a href="{{ unsubscribe }}" style="color:#635BFF;text-decoration:underline;">Unsubscribe</a>
      </p>
    </td>
  </tr>

</table>

</td></tr>
</table>

</body>
</html>`;
}

// ── Helpers ──

function stripTags(str) {
  return str.replace(/<[^>]*>/g, '');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function corsResponse(request, response) {
  const origin = request?.headers?.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
