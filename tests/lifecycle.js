"use strict";
// Trial-ending tests: reminders, grace, pause. Stripe and email are fakes —
// nothing is sent or charged. Run: node tests/lifecycle.js
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.ZEPTOMAIL_TOKEN = process.env.ZEPTOMAIL_TOKEN || "fake";
const path = require("path");
const Module = require("module");
const fake = require("./fakeadmin");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return require.resolve("./fakeadmin");
  return origResolve.call(this, req, ...rest);
};
global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });

const billing = require(path.join(__dirname, "../functions/billing.js"));
const lifecycle = require(path.join(__dirname, "../functions/lifecycle.js"));
const fns = require(path.join(__dirname, "../functions/index.js"));
const { _store: store, _Timestamp: TS } = fake;

const subs = [];
billing._setStripeFactory(() => ({
  subscriptions: { list: async ({ customer }) => ({ data: subs.filter((s) => s.customer === customer) }) },
}));
const outbox = [];
let failNext = false;
lifecycle._setSender(async (to, name, msg) => {
  if (failNext) { failNext = false; throw new Error("ZeptoMail down"); }
  outbox.push({ to, subject: msg.subject, text: msg.text });
});

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`);
  if (!cond) failures++;
}
const D = 86400000;
const at = (days) => new TS(Date.now() + days * D); // +future / -past
const nowS = () => Math.floor(Date.now() / 1000);
const run = async () => { lifecycle._resetConfigCache(); await fns.dailyTrialReminders.run({}); };
const sentTo = (email) => outbox.filter((m) => m.to === email);
const V = (id) => store.get(`vendors/${id}`);
const stamp = (uid, v) => fns.issueStamp.run({ auth: { uid, token: { email: uid + "@x.nz" } }, data: { vendorId: v } });
const base = (extra) => ({ businessName: extra.email.split("@")[0], ownerName: "Sam Owner", requirePin: false, maxStampsPerDay: 99, claimedAt: at(-150), ...extra });

(async () => {
  store.set("vendors/t30", base({ email: "t30@biz.nz", subscriptionStatus: "trialing", trialEndsAt: at(25) }));
  store.set("vendors/t7", base({ email: "t7@biz.nz", subscriptionStatus: "trialing", trialEndsAt: at(5) }));
  store.set("vendors/fresh", base({ email: "fresh@biz.nz", subscriptionStatus: "trialing", trialEndsAt: at(25), claimedAt: at(-2) }));
  store.set("vendors/comp", base({ email: "comp@biz.nz", subscriptionStatus: "active", plan: "standard", trialEndsAt: at(-90) }));
  store.set("vendors/legacy", base({ email: "legacy@biz.nz" }));
  store.set("vendors/susp", base({ email: "susp@biz.nz", status: "suspended", subscriptionStatus: "trialing", trialEndsAt: at(3) }));
  // Saved copy says trial ended, but they've actually subscribed in Stripe.
  store.set("vendors/paid", base({ email: "paid@biz.nz", subscriptionStatus: "trial_ended", trialEndsAt: at(-1), stripeCustomerId: "cus_paid" }));
  subs.push({ id: "sub_paid", customer: "cus_paid", status: "active", created: nowS(), start_date: nowS(), metadata: { plan: "starter" }, items: { data: [{ price: { lookup_key: "stampd_starter_monthly_v1" } }] } });
  store.set("vendors/ended", base({ email: "ended@biz.nz", subscriptionStatus: "trialing", trialEndsAt: at(-1) }));
  store.set("vendors/long", base({ email: "long@biz.nz", subscriptionStatus: "trial_ended", trialEndsAt: at(-20) }));
  store.set("vendors/noplan", base({ email: "noplan@biz.nz", subscriptionStatus: "none", claimedAt: at(-1) }));

  // 1. Master switch OFF (default): nothing sent, but grace/pause still worked out.
  await run();
  check("emails OFF by default → nothing sent", outbox.length === 0, outbox);
  check("trial ended yesterday → trial_ended, grace = end + 14 days, not paused",
    V("ended").subscriptionStatus === "trial_ended" && Math.abs(V("ended").graceEndsAt.toMillis() - (V("ended").trialEndsAt.toMillis() + 14 * D)) < 1000 && !V("ended").paused, V("ended"));
  check("trial ended 20 days ago → paused", V("long").paused === true, V("long"));

  // 2. Switch ON.
  store.set("config/billing", { reminderEmails: true });
  await run();
  check("25 days left (long-time vendor) → 'ends on …' email", sentTo("t30@biz.nz").length === 1 && /ends on/.test(sentTo("t30@biz.nz")[0].subject), sentTo("t30@biz.nz"));
  check("5 days left → 'one week left' email", sentTo("t7@biz.nz").length === 1 && /One week/.test(sentTo("t7@biz.nz")[0].subject), sentTo("t7@biz.nz"));
  check("joined 2 days ago with a short trial → no 30-day email yet", sentTo("fresh@biz.nz").length === 0, sentTo("fresh@biz.nz"));
  check("owner-granted (Paying by hand) → never emailed", sentTo("comp@biz.nz").length === 0);
  check("older vendor with no billing status → never emailed", sentTo("legacy@biz.nz").length === 0);
  check("suspended → never emailed", sentTo("susp@biz.nz").length === 0);
  check("FOOLPROOF: saved 'trial ended' but Stripe says paid → NO email", sentTo("paid@biz.nz").length === 0, sentTo("paid@biz.nz"));
  check("…and their record is corrected from Stripe", V("paid").subscriptionStatus === "active" && V("paid").paused === false, V("paid"));
  check("trial ended → 'has ended' email mentioning the pause date", sentTo("ended@biz.nz").length === 1 && /has ended/.test(sentTo("ended@biz.nz")[0].subject) && /pause/.test(sentTo("ended@biz.nz")[0].text), sentTo("ended@biz.nz"));
  check("paused → 'rewards are paused' email", sentTo("long@biz.nz").length === 1 && /paused/.test(sentTo("long@biz.nz")[0].subject), sentTo("long@biz.nz"));
  check("no-trial vendor → 'choose your plan' email", sentTo("noplan@biz.nz").length === 1 && /Choose your Stampd plan/.test(sentTo("noplan@biz.nz")[0].subject), sentTo("noplan@biz.nz"));
  const logged = [...store].filter(([p]) => p.startsWith("emailLog/")).length;
  check("every email logged", logged === outbox.length, { logged, sent: outbox.length });
  check("emails come with the Stampd dashboard link", outbox.every((m) => m.text.includes("https://stampd.co.nz/dashboard.html")));

  // 3. Never twice.
  const before = outbox.length;
  await run();
  check("second run the same day → nothing new", outbox.length === before, outbox.slice(before));

  // 4. Owner extends a trial → reminders reset to the new date.
  store.get("vendors/t7").trialEndsAt = at(5 + 40); // now 45 days left → nothing due
  await run();
  check("extended to 45 days → nothing due", sentTo("t7@biz.nz").length === 1);
  store.get("vendors/t7").trialEndsAt = at(4);
  await run();
  check("new end date 4 days away → fresh 'one week left' email", sentTo("t7@biz.nz").length === 2, sentTo("t7@biz.nz"));

  // 5. Email service down → not marked sent, retried next run.
  store.set("vendors/retry", base({ email: "retry@biz.nz", subscriptionStatus: "trialing", trialEndsAt: at(3) }));
  failNext = true;
  await run();
  check("send failed → not marked as sent", !(V("retry").billingEmailsSent || []).length, V("retry"));
  await run();
  check("…and sent on the next run", sentTo("retry@biz.nz").length === 1, sentTo("retry@biz.nz"));

  // 6. Paused vendor: stamping refused, kindly.
  try { await stamp("cust1", "long"); check("paused → stamp refused", false); }
  catch (e) { check("paused → stamp refused with 'your stamps are safe'", /paused/.test(e.message) && /safe/.test(e.message), e.message); }
  // Not paused (in grace) → stamping fine.
  const ok = await stamp("cust1", "ended");
  check("in grace period → stamping still works", ok.stamps === 1, ok);

  // 7. Owner turns pausing OFF → stamps go through.
  store.set("config/billing", { reminderEmails: true, pauseStamping: false });
  lifecycle._resetConfigCache();
  const ok2 = await stamp("cust2", "long");
  check("pause switch OFF → paused vendor can stamp", ok2.stamps === 1, ok2);
  const beforeOff = sentTo("long@biz.nz").length;
  await run();
  check("…and the nightly run un-pauses them", V("long").paused === false, V("long"));
  check("…without a 'pauses on <past date>' email", sentTo("long@biz.nz").length === beforeOff, sentTo("long@biz.nz"));
  store.set("config/billing", { reminderEmails: true, pauseStamping: true });
  await run();
  check("switch back ON → paused again", V("long").paused === true, V("long"));

  // 8. Paused vendor picks a plan → back on instantly (syncMyBilling).
  store.get("vendors/long").stripeCustomerId = "cus_long";
  subs.push({ id: "sub_long", customer: "cus_long", status: "active", created: nowS(), start_date: nowS(), metadata: { plan: "standard" }, items: { data: [{ price: { lookup_key: "stampd_standard_monthly_v1" } }] } });
  lifecycle._resetConfigCache();
  await fns.syncMyBilling.run({ auth: { uid: "long", token: {} }, data: {} });
  check("subscribed → paused cleared straight away", V("long").paused === false && !V("long").graceEndsAt, V("long"));
  const ok3 = await stamp("cust3", "long");
  check("…and stamping works again", ok3.stamps === 1, ok3);

  // 9. Owner tools.
  try { await fns.previewTrialReminders.run({ auth: { uid: "nobody", token: {} }, data: {} }); check("preview is owner-only", false); }
  catch (e) { check("preview is owner-only", /permission-denied/.test(e.code), e.code); }
  store.set("owners/boss", {});
  const pv = await fns.previewTrialReminders.run({ auth: { uid: "boss", token: { email: "boss@stampd.co.nz" } }, data: {} });
  check("preview lists due emails without sending", Array.isArray(pv.rows) && pv.reminderEmails === true, pv);
  const n = outbox.length;
  const t = await fns.sendTestReminder.run({ auth: { uid: "boss", token: { email: "boss@stampd.co.nz" } }, data: { kind: "grace_7" } });
  check("test email goes to the owner only, marked [TEST]", t.sentTo === "boss@stampd.co.nz" && outbox.length === n + 1 && outbox[n].to === "boss@stampd.co.nz" && /^\[TEST\]/.test(outbox[n].subject), outbox[n]);

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
