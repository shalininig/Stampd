"use strict";

/* Stampd — vendor subscriptions with Stripe.
 *
 * HOW IT FITS TOGETHER
 *  - Every new vendor starts on a 6-month free trial (onVendorCreated sets
 *    subscriptionStatus "trialing" and trialEndsAt). No card needed to start.
 *  - On the website dashboard (Plan & Billing) the vendor picks a plan and is
 *    sent to Stripe's own hosted checkout page. If they still have trial left,
 *    the Stripe subscription starts with that same trial end date — they are
 *    not charged a cent until the trial is over.
 *  - "Manage billing" opens Stripe's hosted customer portal: update card,
 *    download invoices, switch plan, cancel.
 *  - Stripe is the source of truth once a vendor has subscribed. We copy its
 *    status onto vendors/{uid} (plan, subscriptionStatus, trialEndsAt, …):
 *      · straight after checkout (syncMyBilling, called by the dashboard),
 *      · every night (dailyBillingSync), which also marks expired trials.
 *    No webhook needed — that keeps setup to one secret. A webhook can be
 *    added later if near-instant updates ever matter.
 *  - Billing happens on the WEBSITE only. The phone apps never show prices or
 *    payment buttons (Apple / Google in-app purchase rules).
 *
 * SECRETS: STRIPE_SECRET_KEY (firebase functions:secrets:set STRIPE_SECRET_KEY).
 * A sandbox key (sk_test_…) means pretend money; swapping in the live key is
 * the only change needed to go live — products and prices create themselves.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

// ── Plans ────────────────────────────────────────────────────
// Prices in cents, NZD, per month. Still awaiting Vijay's final decision
// (see Next steps: "Plan prices"). To change a price later, change it here
// AND bump PRICE_VERSION — Stripe prices can't be edited, so a new one is
// created; existing subscribers stay on their old price until moved.
const PLANS = {
  starter: { name: "Stampd Starter", amount: 2900 },
  standard: { name: "Stampd Standard", amount: 4900 },
  pro: { name: "Stampd Pro", amount: 9900 },
};
const CURRENCY = "nzd";
const PRICE_VERSION = "v1";
const TRIAL_MONTHS = 6;

const ALLOWED_ORIGINS = [
  "https://stampd.co.nz",
  "https://www.stampd.co.nz",
  "https://stampd-e4353.web.app",
  "https://stampd-e4353.firebaseapp.com",
  "http://localhost:5000",
];

// Statuses that mean "this vendor is in good standing".
const GOOD_STANDING = ["trialing", "active"];

let stripeFactory = (key) => require("stripe")(key);
/** Tests swap in a fake Stripe client. */
function _setStripeFactory(f) {
  stripeFactory = f;
}

function lookupKey(plan) {
  return `stampd_${plan}_monthly_${PRICE_VERSION}`;
}

function planFromLookupKey(key) {
  const m = /^stampd_(starter|standard|pro)_monthly_/.exec(String(key || ""));
  return m ? m[1] : null;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

/** Defaults written onto a brand-new vendor. */
function newVendorTrial(admin, now = new Date()) {
  return {
    subscriptionStatus: "trialing",
    trialEndsAt: admin.firestore.Timestamp.fromDate(addMonths(now, TRIAL_MONTHS)),
  };
}

/** Stripe needs a trial end at least 48 hours away; otherwise bill now. */
function trialEndFor(vendor, nowMs = Date.now()) {
  const t = vendor && vendor.trialEndsAt && vendor.trialEndsAt.toMillis ? vendor.trialEndsAt.toMillis() : 0;
  if (!t || t < nowMs + 48 * 3600 * 1000) return null;
  return Math.floor(t / 1000);
}

/** What we copy from a Stripe subscription onto vendors/{uid}. */
function vendorFieldsFromSubscription(admin, sub) {
  const ts = (secs) => (secs ? admin.firestore.Timestamp.fromMillis(secs * 1000) : null);
  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  const plan = (sub.metadata && sub.metadata.plan) || planFromLookupKey(price && price.lookup_key) || null;
  // Stripe moved current_period_end onto the item in newer API versions.
  const periodEnd = sub.current_period_end || (item && item.current_period_end) || null;
  return {
    stripeSubscriptionId: sub.id,
    subscriptionStatus: sub.status,
    plan,
    trialEndsAt: ts(sub.trial_end),
    currentPeriodEnd: ts(periodEnd),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    subscriptionSince: ts(sub.start_date),
  };
}

/** The subscription that matters: newest one that isn't a dead checkout. */
function pickSubscription(subs) {
  const list = (subs || []).filter((s) => s.status !== "incomplete_expired");
  list.sort((a, b) => (b.created || 0) - (a.created || 0));
  const live = list.find((s) => s.status !== "canceled");
  return live || list[0] || null;
}

async function ensurePrice(stripe, plan) {
  const key = lookupKey(plan);
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  if (found.data && found.data[0]) return found.data[0];
  const p = PLANS[plan];
  const product = await stripe.products.create({ name: p.name, metadata: { stampdPlan: plan } });
  return stripe.prices.create({
    product: product.id,
    unit_amount: p.amount,
    currency: CURRENCY,
    recurring: { interval: "month" },
    lookup_key: key,
    metadata: { stampdPlan: plan },
  });
}

async function ensureCustomer(stripe, vendorRef, vendor, uid, email) {
  if (vendor.stripeCustomerId) return vendor.stripeCustomerId;
  const c = await stripe.customers.create({
    name: vendor.businessName || undefined,
    email: email || vendor.email || undefined,
    metadata: { vendorId: uid },
  });
  await vendorRef.set({ stripeCustomerId: c.id }, { merge: true });
  return c.id;
}

async function ensurePortalConfig(stripe) {
  const existing = await stripe.billingPortal.configurations.list({ active: true, limit: 20 });
  const mine = (existing.data || []).find((c) => c.metadata && c.metadata.stampd === PRICE_VERSION);
  if (mine) return mine.id;
  const products = [];
  for (const plan of Object.keys(PLANS)) {
    const price = await ensurePrice(stripe, plan);
    products.push({ product: price.product, prices: [price.id] });
  }
  const cfg = await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Stampd — manage your plan and payments" },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["email", "address"] },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products,
      },
    },
    metadata: { stampd: PRICE_VERSION },
  });
  return cfg.id;
}

function originFor(request) {
  const o = request && request.rawRequest && request.rawRequest.headers && request.rawRequest.headers.origin;
  return ALLOWED_ORIGINS.includes(o) ? o : "https://stampd.co.nz";
}

async function syncVendor(db, admin, stripe, vendorId, vendor) {
  if (!vendor.stripeCustomerId) return null;
  const subs = await stripe.subscriptions.list({ customer: vendor.stripeCustomerId, status: "all", limit: 10 });
  const sub = pickSubscription(subs.data);
  if (!sub) return null;
  const fields = vendorFieldsFromSubscription(admin, sub);
  // Don't wipe a trial date we set ourselves when Stripe has none.
  if (!fields.trialEndsAt) delete fields.trialEndsAt;
  await db.collection("vendors").doc(vendorId).set(fields, { merge: true });
  return fields;
}

function build({ db, admin, REGION }) {
  const opts = { region: REGION, secrets: [STRIPE_SECRET_KEY] };
  const stripeClient = () => stripeFactory(STRIPE_SECRET_KEY.value());

  async function requireVendor(request) {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
    const ref = db.collection("vendors").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("permission-denied", "Not a business account.");
    return { uid, ref, vendor: snap.data(), email: request.auth.token && request.auth.token.email };
  }

  // ── createCheckoutSession ─────────────────────────────────
  const createCheckoutSession = onCall(opts, async (request) => {
    const { uid, ref, vendor, email } = await requireVendor(request);
    const plan = String((request.data && request.data.plan) || "");
    if (!PLANS[plan]) throw new HttpsError("invalid-argument", "Pick a plan.");
    if (vendor.stripeSubscriptionId && ["trialing", "active", "past_due", "unpaid", "paused"].includes(vendor.subscriptionStatus)) {
      throw new HttpsError("failed-precondition", "You already have a plan — use Manage billing to change it.");
    }
    const stripe = stripeClient();
    const price = await ensurePrice(stripe, plan);
    const customer = await ensureCustomer(stripe, ref, vendor, uid, email);
    const trialEnd = trialEndFor(vendor);
    const origin = originFor(request);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: uid,
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: {
        metadata: { vendorId: uid, plan },
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
      payment_method_collection: "always",
      allow_promotion_codes: true,
      success_url: `${origin}/dashboard.html?billing=success`,
      cancel_url: `${origin}/dashboard.html?billing=cancel`,
    });
    return { url: session.url };
  });

  // ── createBillingPortalSession ────────────────────────────
  const createBillingPortalSession = onCall(opts, async (request) => {
    const { vendor } = await requireVendor(request);
    if (!vendor.stripeCustomerId) {
      throw new HttpsError("failed-precondition", "Choose a plan first.");
    }
    const stripe = stripeClient();
    const configuration = await ensurePortalConfig(stripe);
    const session = await stripe.billingPortal.sessions.create({
      customer: vendor.stripeCustomerId,
      configuration,
      return_url: `${originFor(request)}/dashboard.html?billing=portal`,
    });
    return { url: session.url };
  });

  // ── syncMyBilling ─────────────────────────────────────────
  // The dashboard calls this after checkout / the portal so the page shows
  // the new plan immediately instead of waiting for the nightly sync.
  const syncMyBilling = onCall(opts, async (request) => {
    const { uid, vendor } = await requireVendor(request);
    const fields = await syncVendor(db, admin, stripeClient(), uid, vendor);
    return { synced: !!fields, status: fields ? fields.subscriptionStatus : vendor.subscriptionStatus || null };
  });

  // ── dailyBillingSync ──────────────────────────────────────
  // 3am NZ. Copies every subscriber's Stripe status (catches failed payments,
  // cancellations, plan changes made in the portal) and closes trials that
  // ran out without a plan being chosen.
  const dailyBillingSync = onSchedule(
    { region: REGION, schedule: "every day 03:00", timeZone: "Pacific/Auckland", secrets: [STRIPE_SECRET_KEY] },
    async () => {
      const stripe = stripeClient();
      const snap = await db.collection("vendors").get();
      let synced = 0, ended = 0, failed = 0;
      for (const d of snap.docs) {
        const v = d.data();
        try {
          if (v.stripeCustomerId) {
            if (await syncVendor(db, admin, stripe, d.id, v)) synced++;
          } else if (
            v.subscriptionStatus === "trialing" &&
            v.trialEndsAt && v.trialEndsAt.toMillis && v.trialEndsAt.toMillis() < Date.now()
          ) {
            await d.ref.set({ subscriptionStatus: "trial_ended" }, { merge: true });
            ended++;
          }
        } catch (e) {
          failed++;
          console.warn("[dailyBillingSync] vendor failed", d.id, e.message || e);
        }
      }
      console.log(`[dailyBillingSync] synced ${synced}, trials ended ${ended}, failed ${failed}`);
    }
  );

  return { createCheckoutSession, createBillingPortalSession, syncMyBilling, dailyBillingSync };
}

module.exports = {
  build,
  newVendorTrial,
  // exported for tests
  _setStripeFactory,
  PLANS,
  GOOD_STANDING,
  lookupKey,
  planFromLookupKey,
  trialEndFor,
  vendorFieldsFromSubscription,
  pickSubscription,
  ensurePrice,
  syncVendor,
};
