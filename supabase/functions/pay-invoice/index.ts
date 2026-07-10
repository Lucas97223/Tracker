// Creates a Stripe hosted-Checkout session for an invoice's open balance.
// Input: { token } (the invoice share token — same thing the public invoice
// page is keyed on). Card details never touch our code (hosted elements only,
// spec §8). The webhook records the payment; this function only sells.

const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? 'http://localhost:5174';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function pg(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!STRIPE_KEY) throw new Error('Stripe is not configured');
    const { token } = await req.json();
    if (!token) throw new Error('Missing invoice token');

    const invoices = await pg(
      `invoices?share_token=eq.${token}&select=id,org_id,number,status,share_token`,
    );
    const invoice = invoices[0];
    if (!invoice || !['sent', 'partial'].includes(invoice.status)) {
      throw new Error('This invoice is not open for payment');
    }
    const totals = (await pg(`v_invoice_totals?invoice_id=eq.${invoice.id}`))[0];
    const balance = Number(totals?.balance ?? 0);
    if (!(balance > 0)) throw new Error('This invoice has no open balance');
    const orgs = await pg(`organizations?id=eq.${invoice.org_id}&select=name`);
    const orgName = orgs[0]?.name ?? 'Invoice';

    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(Math.round(balance * 100)),
      'line_items[0][price_data][product_data][name]': `Invoice #${invoice.number} — ${orgName}`,
      'metadata[invoice_id]': invoice.id,
      'payment_intent_data[description]': `Invoice #${invoice.number} — ${orgName}`,
      success_url: `${APP_ORIGIN}/#/share/invoice/${invoice.share_token}?paid=1`,
      cancel_url: `${APP_ORIGIN}/#/share/invoice/${invoice.share_token}`,
    });

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      throw new Error(session?.error?.message ?? 'Stripe rejected the request');
    }

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : 'Payment setup failed' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
