"use strict";

/* Stampd — our own "confirm your email" and "reset your password" emails.
 *
 * Firebase sends plain emails from "noreply" and won't let this project edit
 * its templates ("Email template updates are currently unavailable", 15 Oct
 * 2026). So the app and website ask these functions instead: Firebase still
 * makes the secure link (generateEmailVerificationLink /
 * generatePasswordResetLink), and we send it through ZeptoMail in Stampd's
 * own design, with the support address, website and app links.
 *
 * The app and website fall back to Firebase's plain email if these fail, so a
 * customer is never left without one.
 *
 * sendVerificationEmail  — signed-in user only; 3 an hour, 8 a day.
 * sendPasswordResetEmail — anyone; always answers "ok" (never reveals whether
 *                          an account exists); limits per connection and per
 *                          address, like the vendor signup form.
 */

const crypto = require("crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const lifecycle = require("./lifecycle");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const APP_STORE = "https://apps.apple.com/nz/app/id6775366390";
const GOOGLE_PLAY = "https://play.google.com/store/apps/details?id=nz.co.stampd.app";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** One design for both emails. Returns { subject, html, text }. */
function accountEmail(kind, { name, email, link }) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  const L = kind === "verify"
    ? {
        subject: "Confirm your email for Stampd",
        preheader: "One tap to confirm your email and keep your stamp cards safe.",
        title: "Confirm your email",
        intro: "Thanks for joining Stampd! Please confirm this is your email address. It means we can help you get back into your account if you ever forget your password, and your stamp cards stay safe.",
        button: "Confirm my email",
        after: "Didn't sign up for Stampd? You can ignore this email and nothing will happen.",
      }
    : {
        subject: "Reset your Stampd password",
        preheader: "Choose a new password for your Stampd account.",
        title: "Reset your password",
        intro: `We got a request to reset the password for your Stampd account (${email}). Tap the button to choose a new one. Your stamp cards and rewards stay exactly as they are.`,
        button: "Choose a new password",
        after: "Didn't ask for this? You can ignore this email and your password won't change. The link stops working after a short while.",
      };

  const a = (href, label) => `<a href="${esc(href)}" style="color:#FF3008;text-decoration:none">${esc(label)}</a>`;
  const html = `<div style="margin:0;padding:0;background:#f4f1ee">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(L.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ee;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
<tr><td style="background:#0D0500;padding:22px 28px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle"><img src="https://stampd.co.nz/icon-192.png" width="40" height="40" alt="" style="display:block;border-radius:9px"></td>
<td style="vertical-align:middle;padding-left:12px;font-size:22px;font-weight:bold;letter-spacing:4px;color:#FF3008">STAMPD</td>
</tr></table></td></tr>
<tr><td style="padding:32px 28px 8px 28px">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1a1a1a">${esc(L.title)}</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#333">Hi ${esc(first)},</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#333">${esc(L.intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="border-radius:12px;background:#FF3008">
<a href="${esc(link)}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:12px">${esc(L.button)}</a>
</td></tr></table>
<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#666">If the button doesn't work, copy this link into your browser:</p>
<p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all"><a href="${esc(link)}" style="color:#FF3008">${esc(link)}</a></p>
<p style="margin:0 0 28px;font-size:13px;line-height:1.6;color:#666">${esc(L.after)}</p>
</td></tr>
<tr><td style="padding:0 28px 28px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee"><tr><td style="padding-top:18px;font-size:13px;line-height:1.8;color:#555">
<strong style="color:#1a1a1a;font-size:14px">The Stampd team</strong><br>
Digital stamp cards for NZ businesses<br>
Email: ${a("mailto:support@stampd.co.nz", "support@stampd.co.nz")}<br>
Web: ${a("https://stampd.co.nz", "stampd.co.nz")}<br>
Get the app: ${a(APP_STORE, "App Store")} &nbsp;|&nbsp; ${a(GOOGLE_PLAY, "Google Play")}
</td></tr></table></td></tr>
</table>
<p style="margin:16px 0 0;font-size:11px;color:#999;font-family:Arial,Helvetica,sans-serif">Sent to ${esc(email)} by Stampd, Wellington, New Zealand.</p>
</td></tr></table></div>`;

  const text = [
    `Hi ${first},`, L.intro, `${L.button}: ${link}`, L.after,
    "— The Stampd team", "Digital stamp cards for NZ businesses",
    "Email: support@stampd.co.nz", "Web: https://stampd.co.nz",
    `Get the app: App Store ${APP_STORE} | Google Play ${GOOGLE_PLAY}`,
  ].join("\n\n");
  return { subject: L.subject, html, text };
}

/** Send people to our own page (stampd.co.nz/account) rather than Firebase's
 *  plain one. Same secure code; anything unexpected keeps Firebase's link. */
function ourLink(link) {
  try {
    const u = new URL(link);
    const mode = u.searchParams.get("mode"), code = u.searchParams.get("oobCode");
    if (!code || !["verifyEmail", "resetPassword"].includes(mode)) return link;
    const out = new URL("https://stampd.co.nz/account");
    out.searchParams.set("mode", mode);
    out.searchParams.set("oobCode", code);
    for (const k of ["apiKey", "lang"]) if (u.searchParams.get(k)) out.searchParams.set(k, u.searchParams.get(k));
    return out.toString();
  } catch (e) {
    return link;
  }
}

function fingerprint(request) {
  const raw = request && request.rawRequest;
  const fwd = raw && raw.headers && String(raw.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || (raw && raw.ip) || "unknown";
  return crypto.createHash("sha256").update("stampd-account-email:" + ip).digest("hex").slice(0, 32);
}

const keyFor = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

/** Records one send against each key; false if any key is over its limit. */
async function allowed(db, keys, now = Date.now()) {
  const refs = keys.map((k) => db.collection("rateLimits").doc(k.id));
  return db.runTransaction(async (tx) => {
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    const lists = snaps.map((s) => ((s.exists && s.data().times) || []).filter((t) => now - t < DAY));
    for (let i = 0; i < keys.length; i++) {
      const hour = lists[i].filter((t) => now - t < HOUR).length;
      if (hour >= keys[i].perHour || lists[i].length >= keys[i].perDay) return false;
    }
    refs.forEach((r, i) => tx.set(r, { times: [...lists[i], now].slice(-keys[i].perDay) }, { merge: true }));
    return true;
  });
}

function build({ db, admin, REGION }) {
  const secrets = [lifecycle.ZEPTOMAIL_TOKEN];

  const sendVerificationEmail = onCall({ region: REGION, secrets }, async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
    const user = await admin.auth().getUser(uid);
    if (!user.email) throw new HttpsError("failed-precondition", "This account has no email address.");
    if (user.emailVerified) return { ok: true, already: true };
    if (!(await allowed(db, [{ id: "verify_" + keyFor(uid), perHour: 3, perDay: 8 }]))) {
      throw new HttpsError("resource-exhausted", "We've sent a few already. Please wait a few minutes and try again.");
    }
    const link = ourLink(await admin.auth().generateEmailVerificationLink(user.email));
    const msg = accountEmail("verify", { name: user.displayName, email: user.email, link });
    await lifecycle.sendEmail(lifecycle.ZEPTOMAIL_TOKEN.value(), user.email, user.displayName, msg);
    await db.collection("emailLog").add({ kind: "verify", uid, to: user.email, at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return { ok: true };
  });

  const sendPasswordResetEmail = onCall({ region: REGION, secrets }, async (request) => {
    const email = String((request.data && request.data.email) || "").trim().toLowerCase().slice(0, 254);
    if (!EMAIL.test(email)) throw new HttpsError("invalid-argument", "That email address doesn't look right.");
    const ok = await allowed(db, [
      { id: "reset_ip_" + fingerprint(request), perHour: 5, perDay: 20 },
      { id: "reset_to_" + keyFor(email), perHour: 3, perDay: 6 },
    ]);
    if (!ok) throw new HttpsError("resource-exhausted", "Too many reset requests. Please wait a few minutes and try again.");

    let user;
    try { user = await admin.auth().getUserByEmail(email); } catch (e) { return { ok: true }; } // no account: say nothing
    const link = ourLink(await admin.auth().generatePasswordResetLink(email));
    const msg = accountEmail("reset", { name: user.displayName, email, link });
    await lifecycle.sendEmail(lifecycle.ZEPTOMAIL_TOKEN.value(), email, user.displayName, msg);
    await db.collection("emailLog").add({ kind: "reset", uid: user.uid, to: email, at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return { ok: true };
  });

  return { sendVerificationEmail, sendPasswordResetEmail };
}

module.exports = { build, accountEmail, ourLink };
