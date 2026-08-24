// plaid-bridge Worker
// Handles the secure parts of Plaid integration that can never live in the
// static frontend: creating link tokens, exchanging public tokens for an
// access token, and pulling fresh balances into Supabase on a schedule.
//
// Bindings needed (set these up in Cloudflare):
//   KV namespace  -> PLAID_TOKENS   (stores the Plaid access token)
//   Secrets       -> PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV,
//                     SUPABASE_URL, SUPABASE_ANON_KEY, SYNC_CODE

const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com'
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-app-secret'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function plaidBase(env) {
  return PLAID_HOSTS[(env.PLAID_ENV || 'sandbox').trim()] || PLAID_HOSTS.sandbox;
}

async function plaidFetch(env, path, body) {
  const stripAll = (v) => (v || '').replace(/\s+/g, '');
  const clientId = stripAll(env.PLAID_CLIENT_ID);
  const secret = stripAll(env.PLAID_SECRET);

  const res = await fetch(`${plaidBase(env)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      secret: secret,
      ...body
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error_message || 'Plaid request failed');
    err.plaid = data;
    err.status = res.status;
    err.diagnostic = {
      clientIdPresent: !!env.PLAID_CLIENT_ID,
      clientIdLengthRaw: (env.PLAID_CLIENT_ID || '').length,
      clientIdLengthCleaned: clientId.length,
      clientIdCleanedValue: clientId, // safe to show -- client_id isn't secret, only the secret value is sensitive
      secretPresent: !!env.PLAID_SECRET,
      secretLengthRaw: (env.PLAID_SECRET || '').length,
      secretLengthCleaned: secret.length,
      plaidEnv: env.PLAID_ENV || '(not set)'
    };
    throw err;
  }
  return data;
}

// --- Route: create a link token so the frontend can launch Plaid Link ---
async function handleCreateLinkToken(env) {
  const data = await plaidFetch(env, '/link/token/create', {
    user: { client_user_id: 'cc-tracker-user' },
    client_name: 'Credit Card Payoff Tracker',
    products: ['liabilities'],
    country_codes: ['US'],
    language: 'en'
  });
  return json({ link_token: data.link_token });
}

// --- Route: exchange the public token (from the frontend after a successful
// Plaid Link connection) for a real access token, and store it in KV ---
// --- Connections are stored as a list under one KV key, keyed by item_id,
// so connecting multiple banks accumulates instead of overwriting. ---
async function getConnections(env) {
  const raw = await env.PLAID_TOKENS.get('connections');
  return raw ? JSON.parse(raw) : [];
}

async function saveConnections(env, connections) {
  await env.PLAID_TOKENS.put('connections', JSON.stringify(connections));
}

async function handleExchangePublicToken(env, publicToken) {
  if (!publicToken) return json({ error: 'Missing public_token' }, 400);
  const data = await plaidFetch(env, '/item/public_token/exchange', {
    public_token: publicToken
  });

  let institutionName = 'Connected bank';
  try {
    const itemInfo = await plaidFetch(env, '/item/get', { access_token: data.access_token });
    if (itemInfo.item?.institution_id) {
      const instInfo = await plaidFetch(env, '/institutions/get_by_id', {
        institution_id: itemInfo.item.institution_id,
        country_codes: ['US']
      });
      institutionName = instInfo.institution?.name || institutionName;
    }
  } catch (err) {
    // Not critical -- worst case the connection just gets a generic label.
  }

  const connections = await getConnections(env);
  // Replace if this exact item was already connected (e.g. re-connecting
  // after a token expired), otherwise add it as a new one.
  const existingIndex = connections.findIndex(c => c.item_id === data.item_id);
  const entry = { item_id: data.item_id, access_token: data.access_token, institution_name: institutionName };
  if (existingIndex >= 0) connections[existingIndex] = entry;
  else connections.push(entry);
  await saveConnections(env, connections);

  return json({ ok: true, institution_name: institutionName, totalConnections: connections.length });
}

// --- Route: fully disconnect ALL connected banks -- revokes access on
// Plaid's side for each one (so connections can't be used again even if a
// token leaked) and clears the stored list, satisfying "delete sensitive
// data when done." ---
async function handleDisconnect(env) {
  const connections = await getConnections(env);
  if (connections.length === 0) {
    return json({ ok: true, reason: 'Nothing was connected.' });
  }
  for (const conn of connections) {
    try {
      await plaidFetch(env, '/item/remove', { access_token: conn.access_token });
    } catch (err) {
      // Even if Plaid's side fails (e.g. already removed), keep going --
      // an orphaned token sitting in KV is the real risk, not a failed
      // courtesy call to Plaid for one connection.
    }
  }
  await env.PLAID_TOKENS.delete('connections');
  return json({ ok: true, disconnectedCount: connections.length });
}

// --- Route: pull fresh balances from every connected bank and push them
// into Supabase, merged into your existing cards rather than overwriting
// anything you've set manually (promo APR, categories, statement balance
// you entered, etc). ---
async function handleSyncBalances(env) {
  const connections = await getConnections(env);
  if (connections.length === 0) return json({ ok: false, reason: 'No bank connected yet.' });

  const plaidCards = [];
  const connectionErrors = [];
  const connectionDetails = [];
  for (const conn of connections) {
    try {
      const liabilities = await plaidFetch(env, '/liabilities/get', { access_token: conn.access_token });
      const creditCount = (liabilities.liabilities?.credit || []).length;
      const allAccounts = liabilities.accounts || [];
      connectionDetails.push({
        institution: conn.institution_name,
        totalAccountsOnItem: allAccounts.length,
        creditAccountsFound: creditCount,
        accountTypesSeen: allAccounts.map(a => `${a.type}/${a.subtype}`)
      });
      (liabilities.liabilities?.credit || []).forEach(l => {
        const account = (liabilities.accounts || []).find(a => a.account_id === l.account_id);
        // Prefer official_name when the account's own nickname is missing or
        // is just a generic label like "Credit Card" -- official_name is
        // usually the actual product name (e.g. "Chase Sapphire Preferred").
        const rawName = account?.name || '';
        const isGeneric = !rawName || /^credit card$/i.test(rawName.trim());
        const name = (isGeneric && account?.official_name) ? account.official_name : (rawName || `${conn.institution_name} card`);
        plaidCards.push({
          plaidAccountId: l.account_id,
          name,
          balance: account?.balances?.current ?? null,
          limit: account?.balances?.limit ?? null,
          statementBalance: l.last_statement_balance ?? null,
          min: l.minimum_payment_amount ?? null,
          dueDate: l.next_payment_due_date || null,
          apr: (l.aprs || []).find(a => a.apr_type === 'purchase_apr')?.apr_percentage ?? null
        });
      });
    } catch (err) {
      connectionErrors.push({ institution: conn.institution_name, error: err.message });
    }
  }

  // Pull current Supabase data, merge Plaid updates into matching cards by
  // plaidAccountId (added the first time a card is linked), and push back.
  const SUPABASE_URL = env.SUPABASE_URL.trim();
  const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY.trim();
  const SYNC_CODE = env.SYNC_CODE.trim();

  const pullRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tracker_sync?sync_code=eq.${encodeURIComponent(SYNC_CODE)}&select=payload`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (!pullRes.ok) return json({ ok: false, step: 'supabase-pull', status: pullRes.status, detail: await pullRes.text() });
  const rows = await pullRes.json();
  const payload = rows[0]?.payload || { cards: [] };
  const cards = payload.cards || [];
  const history = payload.history || [];

  let updatedCount = 0;
  const cardsNeedingAprReview = [];
  plaidCards.forEach(pc => {
    let card = cards.find(c => c.plaidAccountId === pc.plaidAccountId);
    if (!card) {
      // First time seeing this account -- add it as a new card. If Plaid
      // didn't report an APR, DO NOT silently default to 0% -- that would
      // falsely tell the payoff planner this card costs nothing, causing it
      // to deprioritize a card that might actually have a real high rate.
      // Flag it for manual review instead.
      card = {
        id: 'plaid_' + pc.plaidAccountId.slice(0, 8),
        name: pc.name,
        color: '#4FA3FF',
        apr: pc.apr != null ? pc.apr : null,
        categories: [],
        plaidAccountId: pc.plaidAccountId,
        aprNeedsReview: pc.apr == null
      };
      cards.push(card);
    }
    if (card.aprNeedsReview) cardsNeedingAprReview.push(card.name);

    // Auto-log a real history entry for whatever changed since the last
    // sync -- so a Plaid-driven balance drop shows up in the trend chart,
    // "this month" total, and streaks exactly like a manually-logged
    // payment would, instead of the balance silently changing with no
    // record of why.
    if (pc.balance != null && card.lastPlaidBalance != null) {
      const delta = card.lastPlaidBalance - pc.balance; // positive = balance went down = a payment
      if (Math.abs(delta) > 0.005) {
        history.push({
          id: Date.now() + Math.random() + Math.random(),
          cardId: card.id,
          type: delta > 0 ? 'payment' : 'charge',
          amount: Math.round(Math.abs(delta) * 100) / 100,
          note: 'Auto-detected from bank sync',
          date: new Date().toISOString()
        });
      }
    }

    // Only overwrite fields Plaid actually reports -- never clobber things
    // you've set manually that Plaid doesn't know about (like promo APR).
    if (pc.balance != null) {
      card.balance = pc.balance;
      card.lastPlaidBalance = pc.balance;
    }
    if (pc.limit != null) card.limit = pc.limit;
    if (pc.statementBalance != null) card.statementBalance = pc.statementBalance;
    if (pc.min != null) card.min = pc.min;
    if (pc.dueDate) card.dueDate = pc.dueDate;
    updatedCount++;
  });

  payload.cards = cards;
  payload.history = history;
  const pushRes = await fetch(`${SUPABASE_URL}/rest/v1/tracker_sync`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify([{ sync_code: SYNC_CODE, payload, updated_at: new Date().toISOString() }])
  });
  if (!pushRes.ok) return json({ ok: false, step: 'supabase-push', status: pushRes.status, detail: await pushRes.text() });

  return json({
    ok: true,
    cardsUpdated: updatedCount,
    connectionsUsed: connections.length,
    cardsNeedingAprReview: cardsNeedingAprReview.length ? cardsNeedingAprReview : undefined,
    connectionErrors: connectionErrors.length ? connectionErrors : undefined,
    connectionDetails
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    // Require a shared secret on every request. Without this, anyone who
    // discovers this Worker's URL could disconnect your bank, trigger a
    // sync, or attempt to hijack the stored connection -- none of which
    // need to be publicly reachable.
    const expected = (env.APP_SECRET || '').trim();
    const provided = (request.headers.get('x-app-secret') || '').trim();
    if (!expected) {
      return json({ ok: false, error: 'Server misconfigured: APP_SECRET is not set.' }, 500);
    }
    if (provided !== expected) {
      return json({ ok: false, error: 'Unauthorized.' }, 401);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/create-link-token') {
        return await handleCreateLinkToken(env);
      }
      if (url.pathname === '/exchange-public-token') {
        const body = await request.json();
        return await handleExchangePublicToken(env, body.public_token);
      }
      if (url.pathname === '/sync-balances') {
        return await handleSyncBalances(env);
      }
      if (url.pathname === '/disconnect') {
        return await handleDisconnect(env);
      }
      return json({ ok: false, reason: 'Unknown route. Try /create-link-token, /exchange-public-token, or /sync-balances.' }, 404);
    } catch (err) {
      return json({ ok: false, error: err.message, plaid: err.plaid || null, diagnostic: err.diagnostic || null }, err.status || 500);
    }
  },

  // Run the balance sync automatically once a day, same pattern as cc-reminder.
  // This bypasses fetch() entirely -- it calls the sync function directly --
  // so the secret check above doesn't apply to (or block) the scheduled run.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleSyncBalances(env));
  }
};
