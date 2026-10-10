"use strict";
const path = require("path");
const Module = require("module");
const fake = require("./fakeadmin");

// Route require("firebase-admin") to the fake.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "firebase-admin") return require.resolve("./fakeadmin");
  return origResolve.call(this, req, ...rest);
};

const pushes = [];
global.fetch = async (url, opts) => {
  const msgs = JSON.parse(opts.body);
  msgs.forEach((m) => pushes.push(m));
  return { json: async () => ({ data: msgs.map(() => ({ status: "ok" })) }) };
};

const fns = require(path.join(__dirname, "../functions/index.js"));
const { _store: store, _Timestamp: TS } = fake;

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`);
  if (!cond) failures++;
}
const daysAgo = (d) => new TS(Date.now() - d * 86400000);
const card = (uid, v) => store.get(`stampCards/${uid}_${v}`);
const as = (uid) => ({ auth: { uid, token: { email: uid + "@x.nz", name: uid.toUpperCase() } } });
const stamp = (uid, v) => fns.issueStamp.run({ ...as(uid), data: { vendorId: v } });
const choose = (uid, v, choice) => fns.chooseOffer.run({ ...as(uid), data: { vendorId: v, choice } });
const rewardsFor = (uid) => [...store].filter(([p, d]) => p.startsWith("rewards/") && d.customerUid === uid).map(([, d]) => d);

(async () => {
  store.set("vendors/cafe", { businessName: "Hello Cafe", stampGoal: 10, reward: "Free coffee", requirePin: false, maxStampsPerDay: 99 });

  // 1. New card copies the current deal onto itself.
  let out = await stamp("amy", "cafe");
  check("new card: 1 of 10", out.stamps === 1 && out.stampGoal === 10, out);
  check("new card stores its terms", card("amy", "cafe").stampGoal === 10 && card("amy", "cafe").reward === "Free coffee", card("amy", "cafe"));
  await stamp("amy", "cafe"); await stamp("amy", "cafe");

  // 2. Vendor changes offer; Amy (3 stamps) stays on the old deal.
  store.get("vendors/cafe").stampGoal = 6;
  store.get("vendors/cafe").reward = "Free muffin";
  out = await stamp("amy", "cafe");
  check("old deal kept after vendor change: 4 of 10 coffee", out.stamps === 4 && out.stampGoal === 10 && out.reward === "Free coffee", out);

  // 3. A brand-new customer gets the new offer.
  out = await stamp("ben", "cafe");
  check("new customer gets new offer", out.stampGoal === 6 && out.reward === "Free muffin", out);

  // 4. countPartwayCustomers
  let cnt = await fns.countPartwayCustomers.run({ auth: { uid: "cafe", token: {} }, data: {} });
  check("partway count = 2", cnt.partway === 2, cnt);

  // 5. Keep → keptAgainst recorded, stays on old terms.
  out = await choose("amy", "cafe", "keep");
  check("keep: still 4 of 10", out.stamps === 4 && out.stampGoal === 10, out);
  check("keep: keptAgainst = current", JSON.stringify(card("amy", "cafe").keptAgainst) === JSON.stringify({ stampGoal: 6, reward: "Free muffin" }), card("amy", "cafe"));

  // 6. Switch with fewer stamps than the new goal.
  out = await choose("amy", "cafe", "switch");
  check("switch: 4 of 6 muffin, no reward", out.stamps === 4 && out.stampGoal === 6 && !out.rewardEarned, out);
  check("switch clears keptAgainst", card("amy", "cafe").keptAgainst === undefined, card("amy", "cafe"));

  // 7. Switch when already past the new goal → reward now, leftover kept.
  store.set("stampCards/cat_cafe", { vendorId: "cafe", customerUid: "cat", stamps: 8, stampGoal: 10, reward: "Free coffee", lastStampAt: daysAgo(1) });
  out = await choose("cat", "cafe", "switch");
  const catRewards = rewardsFor("cat");
  check("switch past goal: reward created", out.rewardEarned && catRewards.length === 1 && catRewards[0].reward === "Free muffin", { out, catRewards });
  check("switch past goal: 2 left over", card("cat", "cafe").stamps === 2, card("cat", "cafe"));

  // 8. Finishing an old-deal card pays the OLD reward, then the next card is on the current deal.
  store.set("stampCards/dan_cafe", { vendorId: "cafe", customerUid: "dan", stamps: 9, stampGoal: 10, reward: "Free coffee", lastStampAt: daysAgo(1) });
  out = await stamp("dan", "cafe");
  const danR = rewardsFor("dan");
  check("old card completes with old reward", out.rewardEarned && out.reward === "Free coffee" && danR[0] && danR[0].reward === "Free coffee", { out, danR });
  check("next card starts on new deal", card("dan", "cafe").stamps === 0 && card("dan", "cafe").stampGoal === 6 && card("dan", "cafe").reward === "Free muffin", card("dan", "cafe"));

  // 9. Legacy card (no terms of its own) follows the current offer.
  store.set("stampCards/eve_cafe", { vendorId: "cafe", customerUid: "eve", stamps: 3, lastStampAt: daysAgo(2) });
  out = await stamp("eve", "cafe");
  check("legacy card follows current: 4 of 6", out.stamps === 4 && out.stampGoal === 6, out);

  // 10. Expiry: 6-month vendor, card untouched for 7 months → restarts.
  store.set("vendors/barber", { businessName: "Cutz", stampGoal: 5, reward: "Free cut", requirePin: false, maxStampsPerDay: 99, cardExpiryMonths: 6, countWord: "cuts" });
  store.set("stampCards/fay_barber", { vendorId: "barber", customerUid: "fay", stamps: 4, stampGoal: 5, reward: "Free cut", lastStampAt: daysAgo(214) });
  out = await stamp("fay", "barber");
  check("expired card restarts at 1, no reward", out.stamps === 1 && !out.rewardEarned && out.cardRestarted === true, out);
  check("expiredCount recorded", card("fay", "barber").expiredCount === 1, card("fay", "barber"));

  // 11. Not expired at 5 months.
  store.set("stampCards/gus_barber", { vendorId: "barber", customerUid: "gus", stamps: 4, stampGoal: 5, reward: "Free cut", lastStampAt: daysAgo(150) });
  out = await stamp("gus", "barber");
  check("5-month-old card still live → reward", out.rewardEarned === true, out);

  // 12. Expired cards don't count as part-way.
  store.set("stampCards/hal_barber", { vendorId: "barber", customerUid: "hal", stamps: 2, lastStampAt: daysAgo(400) });
  cnt = await fns.countPartwayCustomers.run({ auth: { uid: "barber", token: {} }, data: {} });
  check("expired card not counted part-way", cnt.partway === 1, cnt); // fay (1 stamp) only; gus reset to 0

  // 13. Daily job: reward reminder + expiry warning, each once.
  store.set("users/ivy", { pushTokens: ["ExponentPushToken[ivy]"] });
  store.set("rewards/old1", { customerUid: "ivy", vendorName: "Hello Cafe", reward: "Free coffee", status: "unredeemed", earnedAt: daysAgo(9) });
  store.set("rewards/new1", { customerUid: "ivy", vendorName: "Hello Cafe", reward: "Free coffee", status: "unredeemed", earnedAt: daysAgo(2) });
  store.set("rewards/done1", { customerUid: "ivy", vendorName: "Hello Cafe", reward: "Free coffee", status: "redeemed", earnedAt: daysAgo(20) });
  // 6-month expiry, last stamp ~165 days ago → ~17 days left
  store.set("stampCards/ivy_barber", { vendorId: "barber", customerUid: "ivy", stamps: 4, stampGoal: 5, reward: "Free cut", lastStampAt: daysAgo(165) });
  pushes.length = 0;
  await fns.dailyCustomerReminders.run({});
  const titles = pushes.map((p) => p.title);
  check("one reward reminder sent", titles.filter((t) => t.includes("still waiting")).length === 1, titles);
  check("one expiry warning sent", titles.filter((t) => t.includes("expires")).length === 1, titles);
  check("expiry text says one more visit", pushes.some((p) => p.body.includes("One more visit") && p.body.includes("Free cut")), pushes);
  pushes.length = 0;
  await fns.dailyCustomerReminders.run({});
  check("second run sends nothing", pushes.length === 0, pushes.map((p) => p.title));

  // 14. Opted out → nothing.
  store.set("users/jo", { pushTokens: ["ExponentPushToken[jo]"], notifyRewards: false });
  pushes.length = 0;
  await fns.onRewardCreated.run({ params: { rewardId: "x" }, data: { data: () => ({ customerUid: "jo", reward: "R", vendorName: "V" }) } });
  check("opted-out customer gets no push", pushes.length === 0, pushes);
  pushes.length = 0;
  await fns.onRewardCreated.run({ params: { rewardId: "y" }, data: { data: () => ({ customerUid: "ivy", reward: "Free coffee", vendorName: "Hello Cafe" }) } });
  check("reward-ready push sent", pushes.length === 1 && pushes[0].data.type === "reward_ready", pushes);

  // 15. Bad input
  try { await choose("amy", "cafe", "maybe"); check("bad choice rejected", false); }
  catch (e) { check("bad choice rejected", /invalid-argument/.test(e.code || e.message), e.message); }
  try { await choose("zed", "cafe", "switch"); check("no card → not-found", false); }
  catch (e) { check("no card → not-found", /not-found/.test(e.code || e.message), e.message); }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
