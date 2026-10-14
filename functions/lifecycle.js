"use strict";

/* Stampd — what happens when a vendor's free trial (or plan) ends.
 *
 *   30 days before trial end   email "your trial ends on …"   (long trials only)
 *    7 days before             email reminder
 *   trial ends                 email "your trial has ended"; paid extras stop
 *                              (Featured, rotating PIN) — stamping carries on
 *   14-day grace period        dashboard goes red; email 7 days before the pause
 *   grace over                 STAMPING PAUSES ("rewards are paused — your
 *                              stamps are safe"); email. Nothing is deleted.
 *   vendor picks a plan        everything back instantly (syncMyBilling)
 *
 * WHO GETS THESE EMAILS — the foolproof part:
 *   Only a vendor with NO plan and NO card on file. Before every send we ask
 *   Stripe directly (not our saved copy); anyone with a live Stripe
 *   subscription (trialing / active / past_due) is skipped — Stripe sends
 *   those vendors its own reminders and failed-payment emails.
 *   Never emailed or paused:
 *     · suspended vendors
 *     · vendors the owner has set to "Paying" by hand (free / comp accounts)
 *     · older vendors with no billing status at all
 *   Each email is sent at most once per trial (keyed on the trial end date —
 *   extend someone's trial and their reminders reset to the new date).
 *   Every email sent is logged in emailLog (owner console → vendor Details).
 *
 * OWNER SWITCHES (config/billing, owner console → Revenue):
 *   reminderEmails  — default OFF. Nothing is sent until the owner turns it on.
 *   pauseStamping   — default ON. Turn off and nobody is ever paused.
 *
 * Email goes through ZeptoMail (the same account that sends password resets),
 * from noreply@stampd.co.nz with replies to support@. Secret: ZEPTOMAIL_TOKEN.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const billing = require("./billing");

const ZEPTOMAIL_TOKEN = defineSecret("ZEPTOMAIL_TOKEN");
// Host shown in ZeptoMail → agent_1 → SMTP/API (this account is on the AU data centre).
const ZEPTO_URL = "https://cpaas.zoho.com.au/v1.1/email";
const FROM = { address: "noreply@stampd.co.nz", name: "Stampd" };
const REPLY_TO = { address: "support@stampd.co.nz", name: "Stampd Support" };
const SUPPORT_EMAIL = "support@stampd.co.nz";
// Sign-off on every vendor email — who we are and how to reach us.
const SIGNATURE_TEXT = [
  "— The Stampd team",
  "Stampd · Digital stamp cards for NZ businesses",
  "Email: support@stampd.co.nz",
  "Web: https://stampd.co.nz",
  "Get the app: App Store https://apps.apple.com/nz/app/id6775366390 | Google Play https://play.google.com/store/apps/details?id=nz.co.stampd.app",
].join("\n");
const SIGNATURE_HTML =
  '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:1px solid #e5e5e5;padding-top:14px;font-family:Arial,sans-serif">' +
  '<tr><td style="font-size:15px;color:#222;padding-bottom:4px"><strong>The Stampd team</strong></td></tr>' +
  '<tr><td style="font-size:13px;color:#666;padding-bottom:8px">Digital stamp cards for NZ businesses</td></tr>' +
  '<tr><td style="font-size:13px;line-height:1.7;color:#444">' +
  'Email: <a href="mailto:support@stampd.co.nz" style="color:#FF3008;text-decoration:none">support@stampd.co.nz</a><br>' +
  'Web: <a href="https://stampd.co.nz" style="color:#FF3008;text-decoration:none">stampd.co.nz</a><br>' +
  'Get the app: <a href="https://apps.apple.com/nz/app/id6775366390" style="color:#FF3008;text-decoration:none">App Store</a> &nbsp;|&nbsp; ' +
  '<a href="https://play.google.com/store/apps/details?id=nz.co.stampd.app" style="color:#FF3008;text-decoration:none">Google Play</a>' +
  '</td></tr></table>';
const DASHBOARD = "https://stampd.co.nz/dashboard.html";

const DAY = 86400000;
const GRACE_DAYS = 14;
// Stripe statuses meaning "has a plan and a card on file".
const LIVE_PLAN = ["trialing", "active", "past_due"];

const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : 0);

let sendImpl = null; // tests replace the email sender

// ── Standing ─────────────────────────────────────────────────

function hasLivePlan(v) {
  return !!v.stripeSubscriptionId && LIVE_PLAN.includes(v.subscriptionStatus);
}

/** Owner-granted (no Stripe, status set by hand) or older vendors with no
 *  billing status: never emailed, never paused. */
function isExempt(v) {
  const st = String(v.subscriptionStatus || "");
  if (!st) return true;
  if (!v.stripeSubscriptionId && st === "active") return true;
  return false;
}

/** "good" | "lapsed" | "exempt" */
function standing(v, now = Date.now()) {
  if (isExempt(v)) return "exempt";
  if (hasLivePlan(v)) return "good";
  if (v.subscriptionStatus === "trialing" && !v.stripeSubscriptionId && ms(v.trialEndsAt) > now) return "good";
  return "lapsed";
}

/** When the clock started for a lapsed vendor. */
function lapseStart(v, now) {
  if (v.subscriptionStatus === "canceled" || v.subscriptionStatus === "unpaid") return ms(v.currentPeriodEnd) || now;
  if (v.subscriptionStatus === "none") return ms(v.claimedAt) || ms(v.createdAt) || now;
  return ms(v.trialEndsAt) || now;
}

/** Fields to write so vendors/{id} reflects grace / pause correctly. */
function standingPatch(admin, v, { pauseStamping = true } = {}, now = Date.now()) {
  const s = standing(v, now);
  if (s !== "lapsed") {
    const p = {};
    if (v.graceEndsAt) p.graceEndsAt = admin.firestore.FieldValue.delete();
    if (v.paused) p.paused = false;
    return p;
  }
  const p = {};
  if (v.subscriptionStatus === "trialing" && !v.stripeSubscriptionId) p.subscriptionStatus = "trial_ended";
  let grace = ms(v.graceEndsAt);
  if (!grace) {
    grace = Math.max(lapseStart(v, now), now - GRACE_DAYS * DAY) + GRACE_DAYS * DAY;
    p.graceEndsAt = admin.firestore.Timestamp.fromMillis(grace);
  }
  const shouldPause = pauseStamping && now >= grace;
  if (!!v.paused !== shouldPause) p.paused = shouldPause;
  return p;
}

// ── Which email is due ───────────────────────────────────────

function cycleKey(v) {
  return String(ms(v.trialEndsAt) || ms(v.graceEndsAt) || v.subscriptionStatus || "x");
}

/** The single email this vendor should get today, or null. */
function dueEmail(v, now = Date.now()) {
  if (v.status === "suspended" || !v.email) return null;
  if (standing(v, now) === "exempt" || hasLivePlan(v)) return null;
  const st = v.subscriptionStatus;
  const T = ms(v.trialEndsAt);

  if (st === "trialing" && T > now) {
    const left = Math.ceil((T - now) / DAY);
    const joined = ms(v.claimedAt) || ms(v.createdAt) || 0;
    if (left <= 7) return "trial_7";
    if (left <= 30 && joined && now - joined > 7 * DAY) return "trial_30";
    return null;
  }
  // Lapsed from here on.
  if (v.paused) return "paused";
  const G = ms(v.graceEndsAt);
  // Only warn about a pause that's still ahead (pausing may be switched off).
  if (G && G > now && G - now <= 7 * DAY) return "grace_7";
  if (st === "trial_ended" || (st === "trialing" && T <= now)) return "trial_ended";
  if (st === "none") return "no_plan";
  return null; // canceled / unpaid: Stripe has already told them; only grace_7 + paused from us
}

// Emails only ever move forward: once a later one has gone out this cycle,
// earlier ones are never sent (e.g. no "trial ended" after "paused").
const STAGE = { trial_30: 1, trial_7: 2, trial_ended: 3, no_plan: 3, grace_7: 4, paused: 5 };

function alreadySent(v, kind) {
  if (v.billingEmailCycle !== cycleKey(v)) return false;
  const sent = v.billingEmailsSent || [];
  return sent.includes(kind) || sent.some((k) => (STAGE[k] || 0) > (STAGE[kind] || 0));
}

// ── Email wording ────────────────────────────────────────────

function fmtDate(msVal) {
  return new Date(msVal).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric", timeZone: "Pacific/Auckland" });
}

function emailFor(kind, v) {
  const name = v.ownerName ? String(v.ownerName).split(" ")[0] : "there";
  const biz = v.businessName || "your business";
  const T = ms(v.trialEndsAt), G = ms(v.graceEndsAt);
  const plans = "Starter is NZ$29 + GST a month, or Standard at NZ$49 + GST adds a Featured spot in your suburb and a rotating staff PIN.";
  const how = `Choose a plan here: ${DASHBOARD} (Plan & Billing). You won't be charged until your trial ends.`;
  const L = {
    trial_30: {
      subject: `Your Stampd free trial ends on ${fmtDate(T)}`,
      body: [`Hi ${name},`, `Your free trial for ${biz} ends on ${fmtDate(T)}. To keep your customers collecting stamps without a break, choose a plan before then.`, plans, how],
    },
    trial_7: {
      subject: `One week left on your Stampd free trial`,
      body: [`Hi ${name},`, `Your free trial for ${biz} ends on ${fmtDate(T)} — one week from now.`, plans, how],
    },
    trial_ended: {
      subject: `Your Stampd free trial has ended`,
      body: [`Hi ${name},`, `Your free trial for ${biz} has ended. Your customers can still collect stamps for now, but Featured and the rotating PIN have switched off.`,
        G > Date.now() ? `On ${fmtDate(G)} stamping will pause until a plan is chosen. Your customers' cards and stamps are always kept safe.` : "",
        plans, `Choose a plan here: ${DASHBOARD} (Plan & Billing).`],
    },
    no_plan: {
      subject: `Choose your Stampd plan`,
      body: [`Hi ${name},`, `Welcome to Stampd! To start ${biz}'s loyalty cards, choose a plan.`,
        G > Date.now() ? `Stamping works until ${fmtDate(G)} while you decide.` : "", plans, `Choose a plan here: ${DASHBOARD} (Plan & Billing).`],
    },
    grace_7: {
      subject: `Stampd: your rewards pause on ${fmtDate(G)}`,
      body: [`Hi ${name},`, `${biz} doesn't have a Stampd plan yet, so stamping will pause on ${fmtDate(G)}. Your customers' cards and stamps are kept safe, and everything switches back on the moment you choose a plan.`,
        plans, `Choose a plan here: ${DASHBOARD} (Plan & Billing).`],
    },
    paused: {
      subject: `Your Stampd rewards are paused`,
      body: [`Hi ${name},`, `Stamping at ${biz} is paused because there's no Stampd plan. Your customers' cards and stamps are safe — nothing has been deleted.`,
        `Choose a plan and it all switches back on straight away: ${DASHBOARD} (Plan & Billing).`, plans],
    },
  }[kind];
  if (!L) return null;
  const paras = L.body.filter(Boolean).concat([`Questions? Just reply to this email, or write to us at ${SUPPORT_EMAIL}.`]);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = paras.map((p) => `<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">${esc(p).replace(
    /(https:\/\/[^\s)]+)/g, '<a href="$1" style="color:#FF3008">$1</a>')}</p>`).join("") + SIGNATURE_HTML;
  return { subject: L.subject, text: paras.join("\n\n") + "\n\n" + SIGNATURE_TEXT, html };
}

// ── Sending ──────────────────────────────────────────────────

async function sendEmail(token, to, toName, msg) {
  if (sendImpl) return sendImpl(to, toName, msg);
  const t = String(token || "").trim(); // pasted keys can carry a stray newline
  const auth = t.startsWith("Zoho-enczapikey") ? t : `Zoho-enczapikey ${t}`;
  const res = await fetch(ZEPTO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: auth },
    body: JSON.stringify({
      from: FROM,
      reply_to: [REPLY_TO],
      to: [{ email_address: { address: to, name: toName || to } }],
      subject: msg.subject,
      htmlbody: msg.html,
      textbody: msg.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ZeptoMail ${res.status}: ${body.slice(0, 300)}`);
  }
  return true;
}

async function readConfig(db) {
  try {
    const s = await db.collection("config").doc("billing").get();
    const c = s.exists ? s.data() : {};
    return { reminderEmails: c.reminderEmails === true, pauseStamping: c.pauseStamping !== false };
  } catch (e) {
    return { reminderEmails: false, pauseStamping: true };
  }
}

// issueStamp reads this on every stamp — cache it briefly.
let cfgCache = { at: 0, value: null };
async function pauseEnabled(db) {
  if (!cfgCache.value || Date.now() - cfgCache.at > 5 * 60 * 1000) {
    cfgCache = { at: Date.now(), value: await readConfig(db) };
  }
  return cfgCache.value.pauseStamping;
}

/** Called by issueStamp. True = refuse the stamp. */
async function isStampingPaused(db, vendor) {
  if (vendor.paused !== true) return false;
  if (standing(vendor) !== "lapsed") return false; // e.g. paid since the last nightly run
  return pauseEnabled(db);
}

function build({ db, admin, REGION }) {
  const stripeClient = () => billing._stripe();

  /** The full daily pass for one vendor. Returns what happened. */
  async function processVendor(doc, cfg, { sendEmails }) {
    let v = doc.data();
    // 1. Fresh from Stripe — never trust the saved copy before emailing.
    if (v.stripeCustomerId) {
      const fields = await billing.syncVendor(db, admin, stripeClient(), doc.id, v);
      if (fields) v = { ...v, ...fields };
    }
    // 2. Grace period / pause.
    const patch = standingPatch(admin, v, cfg);
    if (Object.keys(patch).length) {
      await doc.ref.set(patch, { merge: true });
      v = (await doc.ref.get()).data();
    }
    // 3. Email.
    const kind = dueEmail(v);
    if (!kind || alreadySent(v, kind)) return { kind: null };
    if (!sendEmails) return { kind, skipped: "emails off" };
    const msg = emailFor(kind, v);
    await sendEmail(ZEPTOMAIL_TOKEN.value(), v.email, v.ownerName || v.businessName, msg);
    const cycle = cycleKey(v);
    const sent = v.billingEmailCycle === cycle ? [...(v.billingEmailsSent || []), kind] : [kind];
    await doc.ref.set({ billingEmailCycle: cycle, billingEmailsSent: sent }, { merge: true });
    await db.collection("emailLog").add({
      vendorId: doc.id, kind, to: v.email, subject: msg.subject,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { kind, sent: true };
  }

  // 10am NZ every day.
  const dailyTrialReminders = onSchedule(
    { region: REGION, schedule: "every day 10:00", timeZone: "Pacific/Auckland", secrets: [billing.STRIPE_SECRET_KEY, ZEPTOMAIL_TOKEN] },
    async () => {
      const cfg = await readConfig(db);
      const snap = await db.collection("vendors").get();
      let sent = 0, paused = 0, failed = 0;
      for (const d of snap.docs) {
        try {
          const r = await processVendor(d, cfg, { sendEmails: cfg.reminderEmails });
          if (r.sent) sent++;
        } catch (e) {
          failed++;
          console.warn("[dailyTrialReminders] vendor failed", d.id, e.message || e);
        }
      }
      const after = await db.collection("vendors").where("paused", "==", true).get();
      paused = after.size;
      console.log(`[dailyTrialReminders] emails ${cfg.reminderEmails ? "ON" : "OFF"}: sent ${sent}, paused now ${paused}, failed ${failed}`);
    }
  );

  async function requireOwner(request) {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
    const o = await db.collection("owners").doc(uid).get();
    if (!o.exists) throw new HttpsError("permission-denied", "Owner access required.");
    return { uid, email: request.auth.token && request.auth.token.email };
  }

  // Owner console: who would get an email today (no Stripe calls, no sends).
  const previewTrialReminders = onCall({ region: REGION }, async (request) => {
    await requireOwner(request);
    const snap = await db.collection("vendors").get();
    const rows = [];
    snap.forEach((d) => {
      const v = d.data();
      const kind = dueEmail(v);
      if (kind) rows.push({ vendorId: d.id, businessName: v.businessName || "", email: v.email || "", kind, alreadySent: alreadySent(v, kind) });
    });
    const cfg = await readConfig(db);
    return { rows, reminderEmails: cfg.reminderEmails, pauseStamping: cfg.pauseStamping };
  });

  // Owner console: send me a sample of one of the emails.
  const sendTestReminder = onCall({ region: REGION, secrets: [ZEPTOMAIL_TOKEN] }, async (request) => {
    const { email } = await requireOwner(request);
    const kind = String((request.data && request.data.kind) || "trial_7");
    const fake = {
      businessName: "Your Business (sample)", ownerName: "Shalini",
      trialEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * DAY),
      graceEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + 21 * DAY),
    };
    const msg = emailFor(kind, fake);
    if (!msg || !email) throw new HttpsError("invalid-argument", "Unknown email type.");
    await sendEmail(ZEPTOMAIL_TOKEN.value(), email, "Stampd owner", { ...msg, subject: "[TEST] " + msg.subject });
    return { sentTo: email };
  });

  return { dailyTrialReminders, previewTrialReminders, sendTestReminder, _processVendor: processVendor };
}

module.exports = {
  build,
  isStampingPaused,
  standing,
  standingPatch,
  dueEmail,
  emailFor,
  cycleKey,
  alreadySent,
  hasLivePlan,
  _setSender: (f) => { sendImpl = f; },
  _resetConfigCache: () => { cfgCache = { at: 0, value: null }; },
  GRACE_DAYS,
};
