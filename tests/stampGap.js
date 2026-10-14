"use strict";
// How often a customer can collect a stamp (vendor setting stampGapHours).
// Run: node tests/stampGap.js
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
const { _store: store, _Timestamp: TS } = fake;

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`);
  if (!cond) failures++;
}
const H = 3600000;
const as = (uid) => ({ auth: { uid, token: { email: uid + "@x.nz", name: uid } } });
async function tryStamp(gap, lastAgoMs, uid) {
  const v = "v_" + uid;
  store.set(`vendors/${v}`, { businessName: "Cafe", stampGoal: 10, reward: "Coffee", requirePin: false, ...(gap === undefined ? {} : { stampGapHours: gap }) });
  if (lastAgoMs !== null) store.set(`stampCards/${uid}_${v}`, { vendorId: v, customerUid: uid, stamps: 1, stampGoal: 10, reward: "Coffee", stampsToday: 1, lastStampAt: new TS(Date.now() - lastAgoMs) });
  try { await fns.issueStamp.run({ ...as(uid), data: { vendorId: v } }); return "ok"; }
  catch (e) { return e.message; }
}

(async () => {
  check("first ever stamp always allowed", (await tryStamp(24, null, "a")) === "ok");
  let m = await tryStamp(undefined, 60000, "b");
  check("default (no setting) = once a day, says 'tomorrow'", /ready tomorrow\.$/.test(m) && /Thanks for coming in/.test(m), m);
  check("default: allowed next day", (await tryStamp(undefined, 26 * H, "c")) === "ok");
  m = await tryStamp(2, 1 * H, "d");
  check("2 hours: blocked after 1 hour, gives the exact time", /ready from \d{1,2}:\d{2}(am|pm) (today|tomorrow)\.$/.test(m), m);
  check("2 hours: allowed after 3 hours", (await tryStamp(2, 3 * H, "e")) === "ok");
  check("4 hours: allowed after 4h 1m", (await tryStamp(4, 4 * H + 60000, "f")) === "ok");
  check("6 hours: blocked after 5 hours", (await tryStamp(6, 5 * H, "g")) !== "ok");
  m = await tryStamp(48, 60000, "h");
  check("2 days: blocked same day, names the weekday", /ready on (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\.$/.test(m), m);
  check("2 days: allowed after 49 hours", (await tryStamp(48, 49 * H, "i")) === "ok");
  check("3 days: blocked after 1 day", (await tryStamp(72, 25 * H, "j")) !== "ok");
  check("unknown value falls back to once a day", /ready tomorrow/.test(await tryStamp(5, 60000, "k")));
  for (const [g,a] of [[2,H],[24,60000],[48,60000],[72,60000]]) console.log("SAMPLE", g, "=>", await tryStamp(g, a, "s"+g));
  check("no harsh wording", !/already collected|Come back/i.test(m), m);
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
