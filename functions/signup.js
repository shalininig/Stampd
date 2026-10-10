"use strict";

/* Stampd — bot protection for the public vendor signup form, and clean-up of
 * unconfirmed customer accounts.
 *
 * VENDOR SIGNUP (submitVendorApplication)
 * The form on stampd.co.nz used to write straight into vendorApplications, so
 * a script could skip the form and fill the owner's inbox with junk (the
 * "crawlerrobo" signup). Now only this function can create an application,
 * and it checks, in order:
 *   1. an invisible "website" field — humans never see it, bots fill it in
 *   2. how fast the form was filled — under 3 seconds isn't a person
 *   3. junk — links or HTML in the name fields
 *   (1–3 are answered with a fake "thanks" and nothing is saved, so a bot
 *    learns nothing)
 *   4. limits per connection — 3 an hour, 10 a day (real error message)
 *   5. a site-wide ceiling of 100 a day, in case of a flood
 *   6. a duplicate — same email already waiting → no second copy
 * Approval by the owner is still required for every application.
 * The IP address itself is never stored — only a one-way fingerprint.
 *
 * App Check: once enforcement is switched on (see the App Check doc), set
 * ENFORCE_APP_CHECK to true and redeploy so scripts outside the real website
 * are refused outright.
 *
 * UNCONFIRMED CUSTOMER ACCOUNTS (listUnconfirmedAccounts / deleteUnconfirmedAccounts)
 * New customers are sent a confirmation email (app + website). The owner
 * console lists accounts that never confirmed, are 30+ days old and have no
 * stamp cards — almost always bots or typos — and can delete them in one go.
 * Nothing is ever deleted automatically, and every condition is re-checked
 * on the server at the moment of deletion.
 */

const crypto = require("crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const ENFORCE_APP_CHECK = false;
const PER_HOUR = 3;
const PER_DAY = 10;
const SITE_PER_DAY = 100;
const MIN_FILL_MS = 3000;
const STALE_DAYS = 30;
const DAY = 86400000;

const LIMITS = { businessName: 80, ownerName: 60, email: 120, phone: 20, businessType: 40, address: 120, suburb: 40 };
const JUNK = /(https?:\/\/|www\.|<[a-z/]|\[url|\.ru\b|\.xyz\b)/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

function clean(v, max) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
}

function fingerprint(request) {
  const raw = request && request.rawRequest;
  const fwd = raw && raw.headers && String(raw.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || (raw && raw.ip) || "unknown";
  return crypto.createHash("sha256").update("stampd-signup:" + ip).digest("hex").slice(0, 32);
}

/** Pure check of the submitted form. Returns { ok, silent?, error?, data? }. */
function vetApplication(input, nowMs = Date.now()) {
  const d = input || {};
  // 1–3: bot signals → pretend success, save nothing.
  if (clean(d.website, 200)) return { ok: false, silent: true, reason: "honeypot" };
  const elapsed = Number(d.elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return { ok: false, silent: true, reason: "too-fast" };
  const data = {};
  for (const [k, max] of Object.entries(LIMITS)) data[k] = clean(d[k], max);
  if (JUNK.test(data.businessName) || JUNK.test(data.ownerName) || JUNK.test(data.suburb)) {
    return { ok: false, silent: true, reason: "junk" };
  }
  // Real validation errors — a person can fix these.
  if (!data.businessName || !data.ownerName || !data.email || !data.phone || !data.businessType || !data.suburb) {
    return { ok: false, error: "Please fill in all required fields." };
  }
  if (!EMAIL.test(data.email)) return { ok: false, error: "That email address doesn't look right." };
  if (!/^[0-9+()\-\s]{6,20}$/.test(data.phone)) return { ok: false, error: "That phone number doesn't look right." };
  data.email = data.email.toLowerCase();
  return { ok: true, data };
}

function build({ db, admin, REGION }) {
  const submitVendorApplication = onCall({ region: REGION, enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
    const v = vetApplication(request.data);
    if (v.silent) {
      console.log("[signup] dropped", v.reason);
      return { ok: true };
    }
    if (!v.ok) throw new HttpsError("invalid-argument", v.error);

    const now = Date.now();
    const fp = fingerprint(request);
    const dayKey = new Date(now + 12 * 3600000).toISOString().slice(0, 10); // NZ-ish day

    // 4–5: limits, done in a transaction so parallel bot requests can't race past.
    const ipRef = db.collection("rateLimits").doc("signup_" + fp);
    const siteRef = db.collection("rateLimits").doc("signup_site_" + dayKey);
    await db.runTransaction(async (tx) => {
      const [ipSnap, siteSnap] = await Promise.all([tx.get(ipRef), tx.get(siteRef)]);
      const recent = ((ipSnap.exists && ipSnap.data().times) || []).filter((t) => now - t < DAY);
      if (recent.filter((t) => now - t < 3600000).length >= PER_HOUR || recent.length >= PER_DAY) {
        throw new HttpsError("resource-exhausted", "Too many sign-ups from here — please try again later, or email support@stampd.co.nz.");
      }
      const siteCount = (siteSnap.exists && siteSnap.data().count) || 0;
      if (siteCount >= SITE_PER_DAY) {
        throw new HttpsError("resource-exhausted", "We're getting a lot of sign-ups right now — please try again tomorrow, or email support@stampd.co.nz.");
      }
      tx.set(ipRef, { times: [...recent, now].slice(-PER_DAY) }, { merge: true });
      tx.set(siteRef, { count: siteCount + 1 }, { merge: true });
    });

    // 6: duplicate still waiting for approval → don't add another.
    const dup = await db.collection("vendorApplications").where("email", "==", v.data.email).get();
    if (dup.docs.some((d) => (d.data().status || "pending") === "pending")) {
      return { ok: true, duplicate: true };
    }

    await db.collection("vendorApplications").add({
      ...v.data,
      city: "",
      status: "pending",
      source: "website",
      fingerprint: fp,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true };
  });

  async function requireOwner(request) {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
    const o = await db.collection("owners").doc(uid).get();
    if (!o.exists) throw new HttpsError("permission-denied", "Owner access required.");
    return uid;
  }

  /** Is this Auth user safe to delete? Re-checked at deletion time. */
  async function staleUnconfirmed(user, nowMs = Date.now()) {
    if (!user || user.emailVerified || user.disabled) return false;
    const created = Date.parse(user.metadata && user.metadata.creationTime) || nowMs;
    if (nowMs - created < STALE_DAYS * DAY) return false;
    const [vendor, owner, cards, rewards] = await Promise.all([
      db.collection("vendors").doc(user.uid).get(),
      db.collection("owners").doc(user.uid).get(),
      db.collection("stampCards").where("customerUid", "==", user.uid).limit(1).get(),
      db.collection("rewards").where("customerUid", "==", user.uid).limit(1).get(),
    ]);
    return !vendor.exists && !owner.exists && cards.empty && rewards.empty;
  }

  const listUnconfirmedAccounts = onCall({ region: REGION }, async (request) => {
    await requireOwner(request);
    const out = [];
    let pageToken;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      for (const u of page.users) {
        if (await staleUnconfirmed(u)) {
          out.push({ uid: u.uid, email: u.email || "", created: u.metadata.creationTime });
        }
      }
      pageToken = page.pageToken;
    } while (pageToken && out.length < 2000);
    return { accounts: out, staleDays: STALE_DAYS };
  });

  const deleteUnconfirmedAccounts = onCall({ region: REGION }, async (request) => {
    await requireOwner(request);
    const uids = Array.isArray(request.data && request.data.uids) ? request.data.uids.slice(0, 500) : [];
    let deleted = 0, skipped = 0;
    for (const uid of uids) {
      try {
        const u = await admin.auth().getUser(String(uid));
        if (!(await staleUnconfirmed(u))) { skipped++; continue; }
        await admin.auth().deleteUser(u.uid);
        await db.collection("users").doc(u.uid).delete().catch(() => {});
        await db.collection("customers").doc(u.uid).delete().catch(() => {});
        deleted++;
      } catch (e) {
        skipped++;
      }
    }
    return { deleted, skipped };
  });

  return { submitVendorApplication, listUnconfirmedAccounts, deleteUnconfirmedAccounts };
}

module.exports = { build, vetApplication, STALE_DAYS, MIN_FILL_MS };
