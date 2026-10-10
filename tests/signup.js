"use strict";
// Bot protection tests: vendor signup form + unconfirmed-account clean-up.
// Run: node tests/signup.js
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

// Fake Firebase Auth users.
const DAY = 86400000;
const users = new Map();
const addUser = (uid, { verified = false, daysOld = 0, email = uid + "@x.nz" } = {}) =>
  users.set(uid, { uid, email, emailVerified: verified, disabled: false, metadata: { creationTime: new Date(Date.now() - daysOld * DAY).toUTCString() } });
fake.auth = () => ({
  listUsers: async () => ({ users: [...users.values()], pageToken: undefined }),
  getUser: async (uid) => { if (!users.has(uid)) throw new Error("no user"); return users.get(uid); },
  deleteUser: async (uid) => { users.delete(uid); },
});

const fns = require(path.join(__dirname, "../functions/index.js"));
const { vetApplication } = require(path.join(__dirname, "../functions/signup.js"));
const { _store: store } = fake;

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`);
  if (!cond) failures++;
}
const form = (o = {}) => ({ businessName: "Corner Cafe", ownerName: "Sarah Smith", email: "Sarah@Cafe.co.nz", phone: "021 123 4567",
  businessType: "Café / Coffee Shop", address: "1 Queen St", suburb: "Newlands", website: "", elapsedMs: 45000, ...o });
const from = (ip) => ({ rawRequest: { headers: { "x-forwarded-for": ip } } });
const apps = () => [...store].filter(([p]) => p.startsWith("vendorApplications/")).map(([, d]) => d);
const submit = (data, ip = "1.1.1.1") => fns.submitVendorApplication.run({ ...from(ip), data });

(async () => {
  // Pure checks
  check("honeypot filled → silently dropped", vetApplication(form({ website: "http://spam" })).silent === true);
  check("filled in under 3 seconds → silently dropped", vetApplication(form({ elapsedMs: 900 })).silent === true);
  check("no timing at all → silently dropped", vetApplication(form({ elapsedMs: undefined })).silent === true);
  check("link in business name → silently dropped", vetApplication(form({ businessName: "Cheap pills https://x.ru" })).silent === true);
  check("missing suburb → real error", vetApplication(form({ suburb: "" })).error === "Please fill in all required fields.");
  check("bad email → real error", /email/.test(vetApplication(form({ email: "sarah@" })).error || ""));
  check("bad phone → real error", /phone/.test(vetApplication(form({ phone: "call me" })).error || ""));
  check("good form passes, email lower-cased", vetApplication(form()).ok && vetApplication(form()).data.email === "sarah@cafe.co.nz");
  check("long text is trimmed", vetApplication(form({ businessName: "A".repeat(500) })).data.businessName.length === 80);

  // Through the function
  let r = await submit(form());
  check("real application saved as pending", r.ok && apps().length === 1 && apps()[0].status === "pending" && apps()[0].source === "website", apps());
  check("IP address itself is never stored", !JSON.stringify(apps()[0]).includes("1.1.1.1"), apps()[0]);
  r = await submit(form());
  check("same email again while pending → no duplicate", r.ok && r.duplicate && apps().length === 1, { r, n: apps().length });
  r = await submit(form({ website: "x", email: "bot@x.nz" }));
  check("bot (honeypot) gets a fake 'thanks', nothing saved", r.ok && apps().length === 1, apps().length);
  r = await submit(form({ email: "b@c.nz" }), "1.1.1.1");
  check("third real attempt from same place still OK", r.ok && apps().length === 2, apps().length);
  try { await submit(form({ email: "c@d.nz" }), "1.1.1.1"); check("4th in an hour from same place → refused", false); }
  catch (e) { check("4th in an hour from same place → refused with a clear message", /Too many/.test(e.message) && /resource-exhausted/.test(e.code), e.message); }
  r = await submit(form({ email: "other@place.nz" }), "2.2.2.2");
  check("someone else, different connection → fine", r.ok && apps().length === 3, apps().length);
  try { await submit(form({ email: "bad" }), "3.3.3.3"); check("invalid email → refused", false); }
  catch (e) { check("invalid email → refused (invalid-argument)", /invalid-argument/.test(e.code), e.code); }

  // Site-wide flood ceiling
  for (let i = 0; i < 120; i++) { try { await submit(form({ email: `f${i}@flood.nz` }), "9.9." + i + ".1"); } catch (e) {} }
  check("flood capped at 100 a day site-wide", apps().length <= 100, apps().length);

  // Unconfirmed accounts
  addUser("bot1", { daysOld: 45 });                                // stale: unconfirmed, old, nothing
  addUser("new1", { daysOld: 3 });                                 // too new
  addUser("real1", { daysOld: 60, verified: true });               // confirmed
  addUser("stamper", { daysOld: 60 });                             // unconfirmed but has a card
  store.set("stampCards/stamper_v1", { customerUid: "stamper", vendorId: "v1", stamps: 2 });
  addUser("vend1", { daysOld: 90 });                               // a vendor
  store.set("vendors/vend1", { businessName: "V" });
  store.set("owners/boss", {});
  addUser("boss", { daysOld: 200 });                               // the owner
  const owner = { auth: { uid: "boss", token: {} } };

  try { await fns.listUnconfirmedAccounts.run({ auth: { uid: "nobody", token: {} }, data: {} }); check("list is owner-only", false); }
  catch (e) { check("list is owner-only", /permission-denied/.test(e.code), e.code); }
  const list = await fns.listUnconfirmedAccounts.run({ ...owner, data: {} });
  const ids = list.accounts.map((a) => a.uid);
  check("only the stale unconfirmed account is listed", ids.length === 1 && ids[0] === "bot1", ids);

  store.set("users/bot1", { cardView: "list" });
  const del = await fns.deleteUnconfirmedAccounts.run({ ...owner, data: { uids: ["bot1", "stamper", "real1", "vend1", "boss", "new1", "ghost"] } });
  check("delete removes only bot1; everything else re-checked and skipped",
    del.deleted === 1 && del.skipped === 6 && !users.has("bot1") && users.has("stamper") && users.has("real1") && users.has("vend1") && users.has("boss") && users.has("new1"), del);
  check("bot1's leftover profile removed", !store.has("users/bot1"));

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
