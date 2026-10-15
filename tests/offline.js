"use strict";
// Stamps and claims made with no internet and sent later. Run: node tests/offline.js
const path = require("path");
const Module = require("module");
const fake = require("./fakeadmin");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return require.resolve("./fakeadmin");
  return origResolve.call(this, req, ...rest);
};
global.fetch = async (url, opts) => ({ json: async () => ({ data: JSON.parse(opts.body).map(() => ({ status: "ok" })) }) });
const fns = require(path.join(__dirname, "../functions/index.js"));
const pinlib = require(path.join(__dirname, "../functions/pin.js"));
const { _store: store } = fake;
let failures = 0;
const check = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`); if (!cond) failures++; };
const H = 3600000, D = 24 * H;
const as = (uid) => ({ auth: { uid, token: { email: uid + "@x.nz", name: uid } } });
const off = (uid, v, pin, at, requestId) => fns.issueStamp.run({ ...as(uid), data: { vendorId: v, pin, offlineAt: at, requestId } });
const tryIt = async (f) => { try { const r = await f(); return r; } catch (e) { return { err: e.code, msg: e.message, reason: e.details && e.details.reason }; } };

(async () => {
  // A shop that normally needs NO pin when scanning.
  store.set("vendors/shop", { businessName: "Shop", stampGoal: 3, reward: "Free coffee", requirePin: false, stampGapHours: 24 });
  await fns.setOwnStaticPin.run({ ...as("shop"), data: { pin: "3051" } });

  let r = await tryIt(() => off("amy", "shop", "", Date.now() - H, "a1"));
  check("offline stamp always needs the staff PIN (even where scanning doesn't)", r.err && /invalid-argument/.test(r.err), r);
  r = await tryIt(() => off("amy", "shop", "1111", Date.now() - H, "a2"));
  check("wrong PIN refused at sync", r.err && /permission-denied/.test(r.err), r);
  const t1 = Date.now() - 26 * H;
  r = await off("amy", "shop", "3051", t1, "a3");
  check("right PIN: stamp added", r.stamps === 1, r);
  check("card records the real (offline) time", store.get("stampCards/amy_shop").lastStampAt.toMillis() === t1);
  const again = await off("amy", "shop", "3051", t1, "a3");
  check("same offline stamp sent twice (retry) → one stamp", again.stamps === 1 && store.get("stampCards/amy_shop").totalLifetimeStamps === 1);
  r = await tryIt(() => off("amy", "shop", "3051", t1 + 30 * 60000, "a4"));
  check("two offline stamps half an hour apart → second refused by 'how often'", r.reason === "stamp-gap", r);
  r = await tryIt(() => off("amy", "shop", "3051", t1 - 2 * H, "a5"));
  check("an offline stamp from BEFORE the last one is refused (no back-filling)", r.reason === "stamp-gap", r);
  r = await tryIt(() => off("amy", "shop", "3051", Date.now() - 8 * D, "a6"));
  check("older than 7 days refused", r.reason === "offline-too-old", r);
  r = await tryIt(() => off("amy", "shop", "3051", Date.now() + 10 * 60000, "a7"));
  check("time in the future refused", r.reason === "offline-too-old", r);
  r = await off("amy", "shop", "3051", Date.now() - H, "a8");
  check("next day's offline stamp is fine", r.stamps === 2, r);

  // Rotating PIN: the PIN proves when it was typed.
  store.set("vendors/rot", { businessName: "Rot", stampGoal: 5, reward: "Muffin", requirePin: true, pinMode: "rotating", pinIntervalSeconds: 1800, plan: "standard", subscriptionStatus: "trialing", stampGapHours: 2 });
  await fns.issueStamp.run({ ...as("ben"), data: { vendorId: "rot", pin: "0000" } }).catch(() => {}); // creates the secret
  const secret = store.get("vendorSecrets/rot").secret;
  const tPast = Date.now() - 3 * H;
  const pinThen = pinlib.pinForCounter(secret, pinlib.counterFor(Math.floor(tPast / 1000), 1800));
  r = await tryIt(() => off("cat", "rot", pinThen, tPast, "c1"));
  check("rotating PIN valid at the offline time → accepted", r.stamps === 1, r);
  r = await tryIt(() => off("dan", "rot", pinThen, Date.now() - 60000, "d1"));
  check("same old PIN claimed as 'just now' → refused (clock can't be faked)", r.err && /permission-denied/.test(r.err), r);

  // Claim offline
  store.set("vendors/c", { businessName: "C", stampGoal: 1, reward: "Free tea", requirePin: false, maxStampsPerDay: 99 });
  const earned = await fns.issueStamp.run({ ...as("eve"), data: { vendorId: "c" } });
  const at = Date.now() - 2 * H;
  const cl = await fns.redeemReward.run({ ...as("eve"), data: { rewardId: earned.rewardId, scannedVendorId: "c", claimId: "x1", offlineAt: at } });
  const rw = store.get(`rewards/${earned.rewardId}`);
  check("offline claim synced: handed over at the real time, marked offline", cl.ok && rw.redeemedAt.toMillis() === at && rw.redeemedBy === "scan-offline", rw);

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
