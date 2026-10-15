"use strict";
// Handing a reward over on the customer's phone with the staff PIN. Run: node tests/redeem.js
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
const { _store: store } = fake;
let failures = 0;
const check = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`); if (!cond) failures++; };
const as = (uid) => ({ auth: { uid, token: { email: uid + "@x.nz", name: uid } } });
const redeem = (uid, rewardId, pin) => fns.redeemReward.run({ ...as(uid), data: { rewardId, pin } });
const tryIt = async (f) => { try { await f(); return "ok"; } catch (e) { return e.code + ": " + e.message; } };

(async () => {
  store.set("vendors/cafe", { businessName: "Cafe", stampGoal: 2, reward: "Free coffee", requirePin: false, maxStampsPerDay: 99 });
  await fns.setOwnStaticPin.run({ ...as("cafe"), data: { pin: "3051" } });
  await fns.issueStamp.run({ ...as("amy"), data: { vendorId: "cafe" } });
  const out = await fns.issueStamp.run({ ...as("amy"), data: { vendorId: "cafe" } });
  check("reward earned", out.rewardEarned === true, out);
  const [rid] = [...store].filter(([p, d]) => p.startsWith("rewards/") && d.customerUid === "amy").map(([p]) => p.split("/")[1]);

  check("someone else's phone can't redeem it", /not-found/.test(await tryIt(() => redeem("ben", rid, "3051"))));
  check("wrong PIN refused, still waiting", /permission-denied/.test(await tryIt(() => redeem("amy", rid, "1111"))) && store.get(`rewards/${rid}`).status === "unredeemed");
  check("PIN needed even though stamping doesn't ask for one", /invalid-argument/.test(await tryIt(() => redeem("amy", rid, ""))));
  const ok = await redeem("amy", rid, "3051");
  check("right PIN: handed over", ok.ok && store.get(`rewards/${rid}`).status === "redeemed" && ok.reward === "Free coffee", ok);
  check("second time refused — can't be shown again", /already been handed over/.test(await tryIt(() => redeem("amy", rid, "3051"))));
  // Scan to claim
  await fns.issueStamp.run({ ...as("amy"), data: { vendorId: "cafe" } });
  const earned = await fns.issueStamp.run({ ...as("amy"), data: { vendorId: "cafe" } });
  check("earned result carries the reward id", !!earned.rewardId && earned.vendorId === "cafe", earned);
  store.set("vendors/other", { businessName: "Other Place", requirePin: false });
  const wrong = await tryIt(() => fns.redeemReward.run({ ...as("amy"), data: { rewardId: earned.rewardId, scannedVendorId: "other" } }));
  check("scanning the wrong business: clear message, reward kept", /This code is for Other Place/.test(wrong) && store.get(`rewards/${earned.rewardId}`).status === "unredeemed", wrong);
  const c1 = await fns.redeemReward.run({ ...as("amy"), data: { rewardId: earned.rewardId, scannedVendorId: "cafe", claimId: "c-1" } });
  check("scanning the right business claims it, no PIN", c1.ok && store.get(`rewards/${earned.rewardId}`).redeemedBy === "scan", c1);
  const c2 = await fns.redeemReward.run({ ...as("amy"), data: { rewardId: earned.rewardId, scannedVendorId: "cafe", claimId: "c-1" } });
  check("retry of the same claim (dropped connection) answers ok again", c2.ok === true);
  check("a new claim attempt is refused", /already been handed over/.test(await tryIt(() => fns.redeemReward.run({ ...as("amy"), data: { rewardId: earned.rewardId, scannedVendorId: "cafe", claimId: "c-2" } }))));
  check("claiming didn't add a stamp", store.get("stampCards/amy_cafe").stamps === 0, store.get("stampCards/amy_cafe"));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
