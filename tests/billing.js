"use strict";
// Billing tests — Stripe replaced by an in-memory fake. Run: node tests/billing.js
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
const path = require("path");
const Module = require("module");
const fake = require("./fakeadmin");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return require.resolve("./fakeadmin");
  return origResolve.call(this, req, ...rest);
};
global.fetch = async () => ({ json: async () => ({ data: [] }) });

const billing = require(path.join(__dirname, "../functions/billing.js"));
const fns = require(path.join(__dirname, "../functions/index.js"));
const { _store: store, _Timestamp: TS } = fake;

// ── fake Stripe ──
const S = { products: [], prices: [], customers: [], sessions: [], portalCfgs: [], portalSessions: [], subs: [] };
let n = 0;
const id = (p) => `${p}_${++n}`;
const fakeStripe = {
  products: { create: async (o) => { const x = { id: id("prod"), ...o }; S.products.push(x); return x; } },
  prices: {
    list: async ({ lookup_keys }) => ({ data: S.prices.filter((p) => lookup_keys.includes(p.lookup_key)) }),
    create: async (o) => { const x = { id: id("price"), ...o }; S.prices.push(x); return x; },
  },
  customers: { create: async (o) => { const x = { id: id("cus"), ...o }; S.customers.push(x); return x; } },
  checkout: { sessions: { create: async (o) => { const x = { id: id("cs"), url: "https://checkout.stripe.test/" + n, ...o }; S.sessions.push(x); return x; } } },
  billingPortal: {
    configurations: {
      list: async () => ({ data: S.portalCfgs }),
      create: async (o) => { const x = { id: id("bpc"), ...o }; S.portalCfgs.push(x); return x; },
    },
    sessions: { create: async (o) => { const x = { id: id("bps"), url: "https://billing.stripe.test/" + n, ...o }; S.portalSessions.push(x); return x; } },
  },
  subscriptions: { list: async ({ customer }) => ({ data: S.subs.filter((s) => s.customer === customer) }) },
};
billing._setStripeFactory(() => fakeStripe);

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`);
  if (!cond) failures++;
}
const as = (uid) => ({ auth: { uid, token: { email: uid + "@biz.nz" } }, rawRequest: { headers: { origin: "https://stampd.co.nz" } } });
const days = (d) => new TS(Date.now() + d * 86400000);
const nowS = () => Math.floor(Date.now() / 1000);

(async () => {
  // 1. New vendor gets a 6-month trial.
  store.set("vendors/v1", { businessName: "Hello Cafe", applicationId: "a1" });
  await fns.onVendorCreated.run({ params: { vendorId: "v1" }, data: {} });
  const v1 = store.get("vendors/v1");
  const months = (v1.trialEndsAt.toMillis() - Date.now()) / (30.4 * 86400000);
  check("new vendor: trialing, ~6 months", v1.subscriptionStatus === "trialing" && months > 5.8 && months < 6.2, v1);

  // 2. Existing trial isn't overwritten by onVendorCreated.
  store.set("vendors/v9", { businessName: "X", subscriptionStatus: "active", plan: "pro" });
  await fns.onVendorCreated.run({ params: { vendorId: "v9" }, data: {} });
  check("existing status kept", store.get("vendors/v9").subscriptionStatus === "active", store.get("vendors/v9"));

  // 3. Checkout during trial: carries the trial end, creates price + customer once.
  let out = await fns.createCheckoutSession.run({ ...as("v1"), data: { plan: "standard" } });
  const sess = S.sessions[S.sessions.length - 1];
  check("checkout returns a URL", /^https:\/\/checkout/.test(out.url), out);
  check("checkout keeps the trial end", sess.subscription_data.trial_end === Math.floor(v1.trialEndsAt.toMillis() / 1000), sess.subscription_data);
  check("checkout is NZD 49/month", S.prices[0].unit_amount === 4900 && S.prices[0].currency === "nzd" && S.prices[0].recurring.interval === "month", S.prices[0]);
  check("customer id saved on vendor", store.get("vendors/v1").stripeCustomerId === S.customers[0].id, store.get("vendors/v1"));
  check("success URL back to dashboard", sess.success_url === "https://stampd.co.nz/dashboard.html?billing=success", sess.success_url);
  await fns.createCheckoutSession.run({ ...as("v1"), data: { plan: "standard" } });
  check("price and customer reused, not duplicated", S.prices.length === 1 && S.customers.length === 1, { prices: S.prices.length, customers: S.customers.length });

  // 4. Trial ended / nearly over → charged straight away (no trial_end).
  store.set("vendors/v2", { businessName: "Cutz", trialEndsAt: days(1), subscriptionStatus: "trialing" });
  await fns.createCheckoutSession.run({ ...as("v2"), data: { plan: "starter" } });
  check("trial < 48h away → bill now", S.sessions[S.sessions.length - 1].subscription_data.trial_end === undefined, S.sessions[S.sessions.length - 1].subscription_data);

  // 5. Bad plan / not a vendor.
  try { await fns.createCheckoutSession.run({ ...as("v1"), data: { plan: "gold" } }); check("bad plan rejected", false); }
  catch (e) { check("bad plan rejected", /invalid-argument/.test(e.code), e.code); }
  try { await fns.createCheckoutSession.run({ ...as("customer9"), data: { plan: "pro" } }); check("non-vendor rejected", false); }
  catch (e) { check("non-vendor rejected", /permission-denied/.test(e.code), e.code); }

  // 6. Sync after checkout: Stripe says trialing on standard.
  const cus = store.get("vendors/v1").stripeCustomerId;
  S.subs.push({ id: "sub_dead", customer: cus, status: "incomplete_expired", created: nowS() - 50, items: { data: [] } });
  S.subs.push({
    id: "sub_1", customer: cus, status: "trialing", created: nowS(), start_date: nowS(),
    trial_end: Math.floor(v1.trialEndsAt.toMillis() / 1000), cancel_at_period_end: false,
    metadata: { vendorId: "v1", plan: "standard" },
    items: { data: [{ price: { lookup_key: "stampd_standard_monthly_v1" }, current_period_end: nowS() + 99 }] },
  });
  out = await fns.syncMyBilling.run({ ...as("v1"), data: {} });
  let v = store.get("vendors/v1");
  check("sync: plan standard, trialing, sub id", out.synced && v.plan === "standard" && v.subscriptionStatus === "trialing" && v.stripeSubscriptionId === "sub_1", v);

  // 7. Already subscribed → checkout refused, portal works.
  try { await fns.createCheckoutSession.run({ ...as("v1"), data: { plan: "pro" } }); check("second checkout refused", false); }
  catch (e) { check("second checkout refused", /failed-precondition/.test(e.code), e.code); }
  out = await fns.createBillingPortalSession.run({ ...as("v1"), data: {} });
  check("portal URL returned", /^https:\/\/billing/.test(out.url), out);
  check("portal lists all three plans", S.portalCfgs[0].features.subscription_update.products.length === 3, S.portalCfgs[0]);
  await fns.createBillingPortalSession.run({ ...as("v1"), data: {} });
  check("portal config reused", S.portalCfgs.length === 1, S.portalCfgs.length);

  // 8. Portal before any plan → friendly refusal.
  store.set("vendors/v3", { businessName: "New" });
  try { await fns.createBillingPortalSession.run({ ...as("v3"), data: {} }); check("portal without plan refused", false); }
  catch (e) { check("portal without plan refused", /failed-precondition/.test(e.code), e.code); }

  // 9. Nightly sync: payment failed → past_due; plan changed in portal → pro.
  S.subs.find((s) => s.id === "sub_1").status = "past_due";
  S.subs.find((s) => s.id === "sub_1").metadata.plan = undefined;
  S.subs.find((s) => s.id === "sub_1").items.data[0].price.lookup_key = "stampd_pro_monthly_v1";
  // …and an untouched trial that has run out.
  store.set("vendors/v4", { businessName: "Old trial", subscriptionStatus: "trialing", trialEndsAt: days(-2) });
  await fns.dailyBillingSync.run({});
  v = store.get("vendors/v1");
  check("nightly: past_due + plan from price = pro", v.subscriptionStatus === "past_due" && v.plan === "pro", v);
  check("nightly: expired trial marked trial_ended", store.get("vendors/v4").subscriptionStatus === "trial_ended", store.get("vendors/v4"));
  check("nightly: live trial untouched", store.get("vendors/v2").subscriptionStatus === "trialing", store.get("vendors/v2"));

  // 10. Cancelled in portal → canceled after period; rotating PIN stops (canRotate).
  S.subs.find((s) => s.id === "sub_1").status = "canceled";
  await fns.dailyBillingSync.run({});
  check("nightly: canceled", store.get("vendors/v1").subscriptionStatus === "canceled", store.get("vendors/v1"));

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
