// Stripe webhook → idempotent ledger-backed payment.
// Verifies the signature manually (HMAC-SHA256 over `${t}.${body}` per
// Stripe's scheme), fetches the processor fee from the balance transaction,
// then calls record_stripe_payment — whose UNIQUE processor_ref makes every
// retry a no-op. Deployed with --no-verify-jwt (Stripe sends no JWT).

const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function verifySignature(body: string, header: string | null): Promise<boolean> {
  if (!header || !WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min tolerance

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish comparison
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const body = await req.text();
  if (!(await verifySignature(body, req.headers.get('stripe-signature')))) {
    return new Response('invalid signature', { status: 400 });
  }

  const event = JSON.parse(body);
  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify({ ignored: event.type }), { status: 200 });
  }

  const session = event.data.object;
  const invoiceId = session.metadata?.invoice_id;
  if (!invoiceId || session.payment_status !== 'paid') {
    return new Response(JSON.stringify({ ignored: 'no invoice metadata / unpaid' }), { status: 200 });
  }

  const gross = (session.amount_total ?? 0) / 100;

  // Fee from the balance transaction (best effort — 0 when unavailable).
  let fee = 0;
  try {
    const pi = await fetch(
      `https://api.stripe.com/v1/payment_intents/${session.payment_intent}?expand[]=latest_charge.balance_transaction`,
      { headers: { Authorization: `Bearer ${STRIPE_KEY}` } },
    ).then((r) => r.json());
    fee = (pi?.latest_charge?.balance_transaction?.fee ?? 0) / 100;
  } catch (_) { /* fee stays 0; reconciliation catches it later */ }

  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_stripe_payment`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_processor_ref: session.id,
      p_invoice: invoiceId,
      p_gross: gross,
      p_fee: fee,
      p_payload: { event_id: event.id, payment_intent: session.payment_intent },
    }),
  });

  if (!rpc.ok) {
    // Non-200 makes Stripe retry — correct for transient DB issues; the
    // unique processor_ref keeps retries harmless.
    return new Response(await rpc.text(), { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
