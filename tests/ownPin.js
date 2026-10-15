"use strict";
// A business choosing its own fixed PIN. Run: node tests/ownPin.js
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
const { weakPinReason } = require(path.join(__dirname, "../functions/pin.js"));
const { _store: store } = fake;
let failures = 0;
const check = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`); if (!cond) failures++; };
const as = (uid) => ({ auth: { uid, token: { email: uid + "@x.nz" } } });
const setPin = (uid, pin) => fns.setOwnStaticPin.run({ ...as(uid), data: { pin } });
const stamp = (uid, v, pin) => fns.issueStamp.run({ ...as(uid), data: { vendorId: v, pin } });

(async () => {
  for (const bad of ["1234", "4321", "0000", "7777", "1212", "6789", "2580", "123", "12345", "12a4", ""]) {
    check(`refused: "${bad}"`, weakPinReason(bad) !== null, bad);
  }
  for (const ok of ["4778", "1987", "3051", "9260"]) check(`allowed: ${ok}`, weakPinReason(ok) === null, weakPinReason(ok));

  store.set("vendors/shop", { businessName: "Shop", stampGoal: 5, reward: "Free", requirePin: true, pinMode: "rotating", stampGapHours: 2 });
  try { await fns.setOwnStaticPin.run({ data: { pin: "3051" } }); check("needs sign-in", false); }
  catch (e) { check("needs sign-in", /unauthenticated/.test(e.code), e.code); }
  try { await setPin("cust", "3051"); check("customers can't", false); }
  catch (e) { check("customers can't (not a vendor)", /permission-denied/.test(e.code), e.code); }
  try { await setPin("shop", "1111"); check("weak refused", false); }
  catch (e) { check("weak PIN refused with a reason", /invalid-argument/.test(e.code) && /same number/.test(e.message), e.message); }

  const out = await setPin("shop", "3051");
  check("PIN saved in the locked secrets", store.get("vendorSecrets/shop").staticPin === "3051", store.get("vendorSecrets/shop"));
  check("rotating switched to fixed", out.switchedToFixed === true && store.get("vendors/shop").pinMode === "static");
  try { await stamp("amy", "shop", "9999"); check("wrong PIN refused", false); }
  catch (e) { check("wrong PIN refused", /permission-denied/.test(e.code), e.code); }
  const r = await stamp("amy", "shop", "3051");
  check("customer stamps with the chosen PIN", r.stamps === 1, r);
  check("PIN never written to the public vendor record", !("pin" in store.get("vendors/shop")) && !("staticPin" in store.get("vendors/shop")));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
