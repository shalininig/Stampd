"use strict";
// Branded account emails: confirm-your-email and reset-your-password.
// Email sending and Firebase Auth are fakes — nothing is sent. Run: node tests/accountEmails.js
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

const users = new Map();
const addUser = (uid, email, { verified = false, name = "Test Customer A" } = {}) =>
  users.set(uid, { uid, email, displayName: name, emailVerified: verified });
fake.auth = () => ({
  getUser: async (uid) => { if (!users.has(uid)) throw new Error("no user"); return users.get(uid); },
  getUserByEmail: async (email) => { for (const u of users.values()) if (u.email === email) return u; const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; },
  generateEmailVerificationLink: async (email) => `https://stampd-e4353.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=V-${email}`,
  generatePasswordResetLink: async (email) => `https://stampd-e4353.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=R-${email}`,
});

const lifecycle = require(path.join(__dirname, "../functions/lifecycle.js"));
const outbox = [];
lifecycle._setSender(async (to, name, msg) => { outbox.push({ to, name, ...msg }); });
const fns = require(path.join(__dirname, "../functions/index.js"));
const { accountEmail } = require(path.join(__dirname, "../functions/accountEmails.js"));

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`);
  if (!cond) failures++;
}
const as = (uid) => ({ auth: { uid, token: {} } });
const from = (ip) => ({ rawRequest: { headers: { "x-forwarded-for": ip } } });

(async () => {
  // The design
  const v = accountEmail("verify", { name: "Test Customer A", email: "a@x.nz", link: "https://example/link?a=1&b=2" });
  check("verify subject", v.subject === "Confirm your email for Stampd", v.subject);
  check("greets by first name", v.html.includes("Hi Test,") && v.text.startsWith("Hi Test,"));
  check("button carries the link (escaped)", v.html.includes('href="https://example/link?a=1&amp;b=2"'));
  check("signature: support, website, both stores", ["support@stampd.co.nz", "https://stampd.co.nz", "apps.apple.com", "play.google.com"].every((s) => v.html.includes(s) && v.text.includes(s)));
  const r = accountEmail("reset", { name: "", email: "b@x.nz", link: "L" });
  check("reset subject, no name → 'Hi there'", r.subject === "Reset your Stampd password" && r.html.includes("Hi there,"));
  check("names are escaped", accountEmail("verify", { name: "<b>x</b>", email: "e", link: "L" }).html.includes("Hi &lt;b&gt;x&lt;/b&gt;,"));

  // sendVerificationEmail
  addUser("a", "a@x.nz");
  try { await fns.sendVerificationEmail.run({ data: {} }); check("verify needs sign-in", false); }
  catch (e) { check("verify needs sign-in", /unauthenticated/.test(e.code), e.code); }
  let res = await fns.sendVerificationEmail.run({ ...as("a"), data: {} });
  check("verify email sent to the account's own address", res.ok && outbox.length === 1 && outbox[0].to === "a@x.nz" && outbox[0].html.includes("V-a@x.nz"), outbox);
  await fns.sendVerificationEmail.run({ ...as("a"), data: {} });
  await fns.sendVerificationEmail.run({ ...as("a"), data: {} });
  try { await fns.sendVerificationEmail.run({ ...as("a"), data: {} }); check("4th in an hour refused", false); }
  catch (e) { check("4th in an hour refused, politely", /resource-exhausted/.test(e.code) && /wait/.test(e.message), e.message); }
  addUser("b", "b@x.nz", { verified: true });
  const before = outbox.length;
  res = await fns.sendVerificationEmail.run({ ...as("b"), data: {} });
  check("already confirmed → nothing sent", res.already === true && outbox.length === before);

  // sendPasswordResetEmail
  outbox.length = 0;
  res = await fns.sendPasswordResetEmail.run({ ...from("1.1.1.1"), data: { email: " A@X.NZ " } });
  check("reset sent (email tidied: trimmed, lower-case)", res.ok && outbox.length === 1 && outbox[0].to === "a@x.nz" && outbox[0].html.includes("R-a@x.nz"), outbox);
  res = await fns.sendPasswordResetEmail.run({ ...from("1.1.1.1"), data: { email: "nobody@x.nz" } });
  check("no such account → same 'ok', nothing sent", res.ok && outbox.length === 1);
  try { await fns.sendPasswordResetEmail.run({ ...from("1.1.1.1"), data: { email: "bad" } }); check("bad email refused", false); }
  catch (e) { check("bad email refused", /invalid-argument/.test(e.code), e.code); }
  await fns.sendPasswordResetEmail.run({ ...from("2.2.2.2"), data: { email: "a@x.nz" } });
  await fns.sendPasswordResetEmail.run({ ...from("3.3.3.3"), data: { email: "a@x.nz" } });
  try { await fns.sendPasswordResetEmail.run({ ...from("4.4.4.4"), data: { email: "a@x.nz" } }); check("4th reset to one address in an hour refused", false); }
  catch (e) { check("4th reset to one address in an hour refused", /resource-exhausted/.test(e.code), e.code); }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
