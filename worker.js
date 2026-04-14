/**
 * Cloudflare Worker — Landing Page Form Handler
 *
 * Receives POST with { name, email } from simonpowellcoaching.com lead form.
 * 1. Creates a lead in Notion Leads DB (source = Landing Page)
 * 2. Sends Telegram alert to Simon via bot API
 * 3. Adds contact to Brevo to trigger welcome email sequence
 *
 * Environment variables (set in Cloudflare dashboard):
 *   NOTION_TOKEN        — Notion integration token
 *   TELEGRAM_BOT_TOKEN  — @simonjrbot bot token
 *   TELEGRAM_CHAT_ID    — Simon's chat ID (8690381480)
 *   BREVO_API_KEY       — Brevo API key
 *   BREVO_LIST_ID       — Brevo contact list ID for welcome sequence
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

    // Run all three operations concurrently — each is independent
    // If one fails, the others still succeed
    const results = await Promise.allSettled([
      createNotionLead(env, cleanName, cleanEmail),
      sendTelegramAlert(env, cleanName, cleanEmail),
      addToBrevo(env, cleanName, cleanEmail),
    ]);

    // Log failures but don't fail the request
    const errors = [];
    if (results[0].status === 'rejected') errors.push(`Notion: ${results[0].reason}`);
    if (results[1].status === 'rejected') errors.push(`Telegram: ${results[1].reason}`);
    if (results[2].status === 'rejected') errors.push(`Brevo: ${results[2].reason}`);

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
        'Source': { rich_text: [{ text: { content: 'Landing Page' } }] },
        'Date Added': { date: { start: now } },
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

// ── Helpers ──

function stripTags(str) {
  return str.replace(/<[^>]*>/g, '');
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
