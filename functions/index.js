"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { sendToUser } = require("./notify");
const billing = require("./billing");
const lifecycle = require("./lifecycle");
const {
  DEFAULT_INTERVAL_SECONDS,
  validPins,
  newSecret,
  newStaticPin,
} = require("./pin");

admin.initializeApp();
const db = admin.firestore();

// Rotating PINs are a paid-tier feature. Starter keeps the fixed PIN.
const ROTATION_PLANS = ["standard", "pro"];

function canRotate(vendor) {
  if (!ROTATION_PLANS.includes(String(vendor.plan || "").toLowerCase())) return false;
  const status = String(vendor.subscriptionStatus || "").toLowerCase();
  // "trialing" counts — vendors get 6 months free before billing starts.
  return status === "active" || status === "trialing" || status === "";
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes
const REGION = "australia-southeast1";

// ── helpers ──────────────────────────────────────────────────

// The 8-character code printed under a vendor's QR. Derived from the
// document ID, but stored as its own field so it can be looked up with
// a single indexed query instead of scanning every vendor.
function vendorCodeFor(vendorId) {
  return String(vendorId).slice(0, 8).toUpperCase();
}

// Every vendor has a secret (for rotating PINs) and a static PIN.
// Created on demand so vendors that predate this function still work.
async function ensureSecret(vendorId) {
  const ref = db.collection("vendorSecrets").doc(vendorId);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const data = {
    secret: newSecret(),
    staticPin: newStaticPin(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(data);
  return data;
}

function startOfTodayUtcOffset(tzOffsetMinutes) {
  // Vendors are NZ-based; treat "a day" in their local time.
  const now = new Date();
  const local = new Date(now.getTime() + tzOffsetMinutes * 60000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - tzOffsetMinutes * 60000);
}

async function checkRateLimit(key) {
  const ref = db.collection("pinAttempts").doc(key);
  const snap = await ref.get();
  if (!snap.exists) return;
  const d = snap.data();
  if ((d.failed || 0) >= MAX_FAILED_ATTEMPTS) {
    const last = d.lastFailedAt ? d.lastFailedAt.toMillis() : 0;
    if (Date.now() - last < LOCKOUT_MS) {
      throw new HttpsError(
        "resource-exhausted",
        "Too many incorrect PIN attempts. Please wait 10 minutes and try again."
      );
    }
    await ref.set({ failed: 0 }, { merge: true });
  }
}

async function recordFailure(key) {
  await db.collection("pinAttempts").doc(key).set(
    {
      failed: admin.firestore.FieldValue.increment(1),
      lastFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function clearFailures(key) {
  await db.collection("pinAttempts").doc(key).set({ failed: 0 }, { merge: true });
}

// ── Offers and expiry ────────────────────────────────────────
// The deal (goal + reward) is copied onto the stamp card when the card
// starts, so a vendor changing their offer never silently moves the goal
// posts on someone part-way through. The customer chooses whether to switch
// (chooseOffer below). A card with no stamps simply follows the current offer.
// See the "Design decisions - cards, rewards, offers" project doc, sections 5–7.

function currentTerms(vendor) {
  return {
    stampGoal: vendor.stampGoal || 10,
    reward: vendor.reward || "Free item",
  };
}

// The terms a card is actually running on. Cards from before this change
// carry no terms of their own and follow the vendor's current offer.
function cardTermsFor(card, vendor) {
  const cur = currentTerms(vendor);
  if (!card || !(card.stamps > 0) || !card.stampGoal) return cur;
  return { stampGoal: card.stampGoal, reward: card.reward || cur.reward };
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // 31 Aug + 6 months must not roll over into March.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

// 6, 12 or 0 (= never). Counted from the LAST stamp, so only a card nobody
// has touched in that time ever closes.
function expiryMonths(vendor) {
  const m = Number(vendor.cardExpiryMonths || 0);
  return m === 6 || m === 12 ? m : 0;
}

function cardExpiresAt(card, vendor) {
  const months = expiryMonths(vendor);
  if (!months || !card || !card.lastStampAt || !card.lastStampAt.toDate) return null;
  return addMonths(card.lastStampAt.toDate(), months);
}

function cardIsExpired(card, vendor, now = new Date()) {
  const at = cardExpiresAt(card, vendor);
  return !!(at && (card.stamps || 0) > 0 && at <= now);
}

// ── issueStamp ───────────────────────────────────────────────
// The ONLY way a stamp is created. Clients can no longer write
// stampCards directly (see firestore.rules).
exports.issueStamp = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");

  const vendorId = String((request.data && request.data.vendorId) || "").trim();
  const pin = String((request.data && request.data.pin) || "").trim();
  if (!vendorId) throw new HttpsError("invalid-argument", "Missing vendor.");

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  if (!vendorSnap.exists) {
    throw new HttpsError("not-found", "That business isn't on Stampd.");
  }
  const vendor = vendorSnap.data();

  // Trial / plan ended and the grace period is over — see lifecycle.js.
  if (await lifecycle.isStampingPaused(db, vendor)) {
    throw new HttpsError(
      "failed-precondition",
      "This business's Stampd rewards are paused right now. Your stamps are safe — please let the staff know."
    );
  }

  if (vendor.status === "suspended") {
    throw new HttpsError("failed-precondition", "This business isn't active on Stampd right now.");
  }

  const attemptKey = `${uid}_${vendorId}`;
  // `requiresPin` is the older field name used by the website. Honour
  // whichever is present; default to ON for anything that has neither.
  const requirePin =
    vendor.requirePin !== undefined
      ? vendor.requirePin !== false
      : vendor.requiresPin !== undefined
      ? vendor.requiresPin !== false
      : true;

  if (requirePin) {
    await checkRateLimit(attemptKey);
    if (!pin) throw new HttpsError("invalid-argument", "PIN required.");

    const secrets = await ensureSecret(vendorId);
    // A vendor who drops off the paid plan silently falls back to the
    // fixed PIN — the setting alone can't unlock rotation.
    const mode = vendor.pinMode === "rotating" && canRotate(vendor) ? "rotating" : "static";
    let ok;
    if (mode === "rotating") {
      const interval = vendor.pinIntervalSeconds || DEFAULT_INTERVAL_SECONDS;
      ok = validPins(secrets.secret, interval, Math.floor(Date.now() / 1000)).includes(pin);
    } else {
      ok = pin === secrets.staticPin;
    }
    if (!ok) {
      await recordFailure(attemptKey);
      throw new HttpsError("permission-denied", "Incorrect PIN.");
    }
    await clearFailures(attemptKey);
  }

  // One stamp per customer per vendor per day (vendor can raise it).
  const cardId = `${uid}_${vendorId}`;
  const cardRef = db.collection("stampCards").doc(cardId);
  const cardSnap = await cardRef.get();
  const maxPerDay = vendor.maxStampsPerDay || 1;
  if (cardSnap.exists) {
    const card = cardSnap.data();
    const dayStart = startOfTodayUtcOffset(vendor.tzOffsetMinutes || 720); // NZ default
    const last = card.lastStampAt ? card.lastStampAt.toDate() : null;
    const todayCount = last && last >= dayStart ? card.stampsToday || 1 : 0;
    if (todayCount >= maxPerDay) {
      throw new HttpsError(
        "failed-precondition",
        "You've already collected a stamp here today. Come back tomorrow!"
      );
    }
  }

  const cur = currentTerms(vendor);

  // The vendor screens show who the customer is. Nothing was writing it, so
  // every card and reward read back as an anonymous "Customer". Take it from
  // the auth token, which is the only trustworthy source here.
  const tok = (request.auth && request.auth.token) || {};
  const customerName = String(tok.name || (tok.email ? String(tok.email).split("@")[0] : "") || "Customer").slice(0, 60);
  const customerEmail = String(tok.email || "").slice(0, 120);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    const dayStart = startOfTodayUtcOffset(vendor.tzOffsetMinutes || 720);
    let stamps = 1;
    let totalLifetime = 1;
    let stampsToday = 1;
    let terms = cur;
    let expired = false;

    if (snap.exists) {
      const card = snap.data();
      expired = cardIsExpired(card, vendor);
      // An expired card starts again from nothing, on the current offer.
      const before = expired ? 0 : card.stamps || 0;
      terms = expired ? cur : cardTermsFor(card, vendor);
      stamps = before + 1;
      totalLifetime = (card.totalLifetimeStamps || 0) + 1;
      const last = card.lastStampAt ? card.lastStampAt.toDate() : null;
      stampsToday = last && last >= dayStart ? (card.stampsToday || 0) + 1 : 1;
    }

    const stampGoal = terms.stampGoal;
    const rewardText = terms.reward;
    const rewardEarned = stamps >= stampGoal;
    const stampsAfter = rewardEarned ? 0 : stamps;
    // Once a card completes, the next one starts on whatever is current.
    const nextTerms = rewardEarned ? cur : terms;

    tx.set(
      cardRef,
      {
        vendorId,
        customerUid: uid,
        customerName,
        customerEmail,
        vendorName: vendor.businessName || "Business",
        stamps: stampsAfter,
        stampGoal: nextTerms.stampGoal,
        reward: nextTerms.reward,
        totalLifetimeStamps: totalLifetime,
        stampsToday,
        lastStampAt: admin.firestore.FieldValue.serverTimestamp(),
        // Cleared whenever the card's terms are reset to the current offer.
        ...(rewardEarned || expired || !snap.exists
          ? { keptAgainst: admin.firestore.FieldValue.delete() }
          : {}),
        ...(expired
          ? {
              expiredCount: admin.firestore.FieldValue.increment(1),
              lastExpiredAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          : {}),
      },
      { merge: true }
    );

    // Record the reward so it survives the card resetting to zero.
    // This is what the vendor redeems against.
    if (rewardEarned) {
      const rewardRef = db.collection("rewards").doc();
      tx.set(rewardRef, {
        customerUid: uid,
        customerName,
        customerEmail,
        vendorId,
        vendorName: vendor.businessName || "Business",
        reward: rewardText,
        status: "unredeemed",
        earnedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return {
      stamps: rewardEarned ? stampGoal : stampsAfter,
      rewardEarned,
      stampGoal,
      reward: rewardText,
      expired,
    };
  });

  return {
    businessName: vendor.businessName || "Business",
    stamps: result.stamps,
    stampGoal: result.stampGoal,
    reward: result.reward,
    rewardEarned: result.rewardEarned,
    // True when an old card had lapsed and this stamp started a new one.
    cardRestarted: result.expired,
    // What this vendor calls what they count ("visits", "cuts", ...), so the
    // success screen can say "3 of 5 visits" rather than always "stamps".
    countWord: vendor.countWord || "stamps",
  };
});

// ── chooseOffer ──────────────────────────────────────────────
// A customer part-way through a card, whose vendor has since changed the
// offer, picks: keep going on the old deal, or switch with their stamps
// carried over. Nobody ever loses stamps. If they already have enough for
// the new goal, switching earns the new reward on the spot.
exports.chooseOffer = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
  const vendorId = String((request.data && request.data.vendorId) || "").trim();
  const choice = String((request.data && request.data.choice) || "");
  if (!vendorId || (choice !== "keep" && choice !== "switch")) {
    throw new HttpsError("invalid-argument", "Missing vendor or choice.");
  }

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  if (!vendorSnap.exists) throw new HttpsError("not-found", "That business isn't on Stampd.");
  const vendor = vendorSnap.data();
  const cur = currentTerms(vendor);

  const tok = (request.auth && request.auth.token) || {};
  const customerName = String(tok.name || (tok.email ? String(tok.email).split("@")[0] : "") || "Customer").slice(0, 60);
  const customerEmail = String(tok.email || "").slice(0, 120);

  const cardRef = db.collection("stampCards").doc(`${uid}_${vendorId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    if (!snap.exists) throw new HttpsError("not-found", "No card here yet.");
    const card = snap.data();
    const old = cardTermsFor(card, vendor);
    const stamps = card.stamps || 0;

    if (choice === "keep") {
      tx.set(cardRef, { keptAgainst: cur }, { merge: true });
      return { stamps, stampGoal: old.stampGoal, reward: old.reward, rewardEarned: false };
    }

    // Switch.
    let left = stamps;
    let rewardEarned = false;
    if (stamps >= cur.stampGoal) {
      rewardEarned = true;
      left = Math.min(stamps - cur.stampGoal, cur.stampGoal - 1);
      tx.set(db.collection("rewards").doc(), {
        customerUid: uid,
        customerName,
        customerEmail,
        vendorId,
        vendorName: vendor.businessName || "Business",
        reward: cur.reward,
        status: "unredeemed",
        earnedAt: admin.firestore.FieldValue.serverTimestamp(),
        viaOfferSwitch: true,
      });
    }
    tx.set(
      cardRef,
      {
        stamps: left,
        stampGoal: cur.stampGoal,
        reward: cur.reward,
        keptAgainst: admin.firestore.FieldValue.delete(),
        switchedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { stamps: left, stampGoal: cur.stampGoal, reward: cur.reward, rewardEarned };
  });
});

// ── countPartwayCustomers ────────────────────────────────────
// Vendors only. Before saving a new offer the vendor is told the truth:
// "14 customers are part-way through. They'll be offered the choice."
exports.countPartwayCustomers = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
  const v = await db.collection("vendors").doc(uid).get();
  if (!v.exists) throw new HttpsError("permission-denied", "Not a vendor account.");
  const vendor = v.data();
  const snap = await db.collection("stampCards").where("vendorId", "==", uid).get();
  let n = 0;
  snap.forEach((d) => {
    const c = d.data();
    if ((c.stamps || 0) > 0 && !cardIsExpired(c, vendor)) n++;
  });
  return { partway: n };
});

// ── getVendorPinConfig ───────────────────────────────────────
// Vendors only. Returns the secret so the vendor's own device can
// compute the rotating PIN offline, plus the static PIN.
exports.getVendorPinConfig = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");

  const vendorSnap = await db.collection("vendors").doc(uid).get();
  if (!vendorSnap.exists) {
    throw new HttpsError("permission-denied", "Not a vendor account.");
  }
  const vendor = vendorSnap.data();
  const secrets = await ensureSecret(uid);

  return {
    secret: secrets.secret,
    staticPin: secrets.staticPin,
    pinMode: vendor.pinMode === "rotating" && canRotate(vendor) ? "rotating" : "static",
    canRotate: canRotate(vendor),
    plan: vendor.plan || null,
    requirePin:
      vendor.requirePin !== undefined
        ? vendor.requirePin !== false
        : vendor.requiresPin !== undefined
        ? vendor.requiresPin !== false
        : true,
    intervalSeconds: vendor.pinIntervalSeconds || DEFAULT_INTERVAL_SECONDS,
    serverTimeSeconds: Math.floor(Date.now() / 1000),
  };
});

// ── regenerateStaticPin ──────────────────────────────────────
// Called when a vendor turns rotation OFF, so they never fall back
// to a stale PIN their regulars already memorised.
exports.regenerateStaticPin = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");

  const vendorSnap = await db.collection("vendors").doc(uid).get();
  if (!vendorSnap.exists) {
    throw new HttpsError("permission-denied", "Not a vendor account.");
  }
  await ensureSecret(uid);
  const staticPin = newStaticPin();
  await db.collection("vendorSecrets").doc(uid).set(
    { staticPin, staticPinChangedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { staticPin };
});

// ── onVendorCreated ──────────────────────────────────────────
// Preassign a secret and PIN the moment a vendor account exists,
// so nobody has to set one up by hand.
exports.onVendorCreated = onDocumentCreated(
  { region: REGION, document: "vendors/{vendorId}" },
  async (event) => {
    const vendorId = event.params.vendorId;
    await ensureSecret(vendorId);
    // Every vendor starts on the free trial unless one is already set.
    const snap = await db.collection("vendors").doc(vendorId).get();
    const v = snap.exists ? snap.data() : {};
    const trial = v.trialEndsAt || v.subscriptionStatus
      ? {}
      : billing.newVendorTrial(admin, await billing.trialMonthsFor(db));
    await db.collection("vendors").doc(vendorId).set(
      {
        ...trial,
        vendorCode: vendorCodeFor(vendorId),
        requirePin: true,
        pinMode: "static",
        pinIntervalSeconds: DEFAULT_INTERVAL_SECONDS,
      },
      { merge: true }
    );
  }
);

// ── backfillVendorCodes ──────────────────────────────────────
// One-off, owner-only. Writes vendorCode onto vendors created before
// that field existed. Safe to run more than once — it skips vendors
// that already have it.
exports.backfillVendorCodes = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
  const owner = await db.collection("owners").doc(uid).get();
  if (!owner.exists) throw new HttpsError("permission-denied", "Owner access required.");

  const snap = await db.collection("vendors").get();
  let updated = 0;
  let batch = db.batch();
  let inBatch = 0;

  for (const d of snap.docs) {
    const want = vendorCodeFor(d.id);
    if (d.data().vendorCode === want) continue;
    batch.set(d.ref, { vendorCode: want }, { merge: true });
    updated++;
    inBatch++;
    if (inBatch === 400) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  return { scanned: snap.size, updated };
});

// ── ensureVendorCode ─────────────────────────────────────────
// Safety net: a vendor opening their own app fills in their code if
// the backfill hasn't run yet.
exports.ensureVendorCode = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in.");
  const ref = db.collection("vendors").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("permission-denied", "Not a vendor account.");
  const want = vendorCodeFor(uid);
  if (snap.data().vendorCode !== want) {
    await ref.set({ vendorCode: want }, { merge: true });
  }
  return { vendorCode: want };
});

// ── Customer notifications ───────────────────────────────────
// See notify.js. Only things the customer would want to know about their
// own cards — never promotions.

// "Your reward is ready" — the moment a card completes. If the app is open
// the phone suppresses the banner (the celebration is already on screen),
// but it still lands in the notification list as a record.
exports.onRewardCreated = onDocumentCreated(
  { region: REGION, document: "rewards/{rewardId}" },
  async (event) => {
    const r = event.data && event.data.data();
    if (!r || !r.customerUid) return;
    await sendToUser(db, admin, r.customerUid, {
      title: "⭐ Your reward is ready",
      body: `${r.reward || "Your reward"} at ${r.vendorName || "the shop"}. Show your Stampd card at the counter.`,
      data: { type: "reward_ready", vendorId: r.vendorId || "" },
    });
  }
);

const REWARD_REMINDER_DAYS = 7;

// Runs once a day at 10am NZ time.
//  1. A reward earned 7+ days ago and still not handed over gets ONE reminder.
//  2. Cards about to expire get a heads-up (see cardExpiryWarnings below).
exports.dailyCustomerReminders = onSchedule(
  { region: REGION, schedule: "every day 10:00", timeZone: "Pacific/Auckland" },
  async () => {
    const cutoff = Date.now() - REWARD_REMINDER_DAYS * 86400000;
    // Single-field equality query: no composite index needed. Filtered in
    // memory — the unredeemed set is small.
    const snap = await db.collection("rewards").where("status", "==", "unredeemed").get();
    let sent = 0;
    for (const d of snap.docs) {
      const r = d.data();
      if (r.reminderSentAt) continue;
      const earned = r.earnedAt && r.earnedAt.toMillis ? r.earnedAt.toMillis() : 0;
      if (!earned || earned > cutoff) continue;
      // Mark first, so a crash mid-run can never send the same reminder twice.
      await d.ref.set({ reminderSentAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      const n = await sendToUser(db, admin, r.customerUid, {
        title: "Your reward is still waiting",
        body: `${r.reward || "Your reward"} at ${r.vendorName || "the shop"} — pop in and show your Stampd card.`,
        data: { type: "reward_reminder", vendorId: r.vendorId || "" },
      });
      if (n) sent++;
    }
    console.log(`[dailyCustomerReminders] reward reminders sent: ${sent}`);
    await cardExpiryWarnings();
  }
);

// Card-expiry heads-up: once per card, 3 weeks before it lapses.
// Called from dailyCustomerReminders.
const EXPIRY_WARNING_DAYS = 21;

async function cardExpiryWarnings() {
  const vendors = await db.collection("vendors").where("cardExpiryMonths", ">", 0).get();
  const now = Date.now();
  let sent = 0;
  for (const v of vendors.docs) {
    const vendor = v.data();
    if (!expiryMonths(vendor)) continue;
    const cards = await db.collection("stampCards").where("vendorId", "==", v.id).get();
    for (const d of cards.docs) {
      const c = d.data();
      if (!((c.stamps || 0) > 0)) continue;
      const at = cardExpiresAt(c, vendor);
      if (!at) continue;
      const daysLeft = Math.ceil((at.getTime() - now) / 86400000);
      if (daysLeft <= 0 || daysLeft > EXPIRY_WARNING_DAYS) continue;
      const stampKey = c.lastStampAt.toMillis();
      if (c.expiryWarnedFor === stampKey) continue; // already warned for this stretch
      await d.ref.set({ expiryWarnedFor: stampKey }, { merge: true });

      const terms = cardTermsFor(c, vendor);
      const left = Math.max(terms.stampGoal - c.stamps, 0);
      const word = String(vendor.countWord || "stamps");
      const when = daysLeft <= 7 ? `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : `in ${Math.round(daysLeft / 7)} weeks`;
      const n = await sendToUser(db, admin, c.customerUid, {
        title: `Your ${vendor.businessName || "Stampd"} card expires ${when}`,
        body: left === 1
          ? `One more visit and your ${terms.reward} is yours.`
          : `You're ${c.stamps} of ${terms.stampGoal} ${word}. Visit before then to keep them.`,
        data: { type: "card_expiry", vendorId: v.id },
      });
      if (n) sent++;
    }
  }
  console.log(`[cardExpiryWarnings] sent: ${sent}`);
}

// ── Vendor subscriptions (Stripe) ─────────────────────────────
// See billing.js.
Object.assign(exports, billing.build({ db, admin, REGION }));

// ── Trial ending: reminders, grace period, pause ──────────────
// See lifecycle.js.
{
  const { dailyTrialReminders, previewTrialReminders, sendTestReminder } = lifecycle.build({ db, admin, REGION });
  Object.assign(exports, { dailyTrialReminders, previewTrialReminders, sendTestReminder });
}

