"use strict";

/* Stampd — sending push notifications.
 *
 * Uses the Expo push service (https://exp.host). The phone app registers an
 * Expo push token (StampdApp/constants/notifications.ts) and stores it on
 * users/{uid}.pushTokens. Expo forwards to Apple (APNs) and Google (FCM)
 * using the credentials held in the Expo/EAS project — so this server needs
 * no Apple or Google keys of its own.
 *
 * Every send respects users/{uid}.notifyRewards === false (the Profile switch).
 * Tokens Expo reports as dead (app deleted, notifications revoked) are removed.
 *
 * Nothing in here is marketing. Promotional pushes (flash offers, after
 * launch) must check a separate opt-in field — Apple guideline 4.5.4.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

function isExpoToken(t) {
  return typeof t === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(t);
}

/**
 * Send one notification to every device a customer is signed in on.
 * Never throws — a failed push must never fail the thing that triggered it.
 * @returns {Promise<number>} how many devices Expo accepted it for
 */
async function sendToUser(db, admin, uid, { title, body, data }) {
  try {
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return 0;
    const user = snap.data();
    if (user.notifyRewards === false) return 0;
    const tokens = (user.pushTokens || []).filter(isExpoToken);
    if (!tokens.length) return 0;

    const messages = tokens.map((to) => ({
      to,
      title,
      body,
      data: data || {},
      sound: "default",
      channelId: "rewards",
      priority: "high",
    }));

    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(messages),
    });
    const json = await res.json().catch(() => ({}));
    const tickets = Array.isArray(json.data) ? json.data : [];

    let ok = 0;
    const dead = [];
    tickets.forEach((t, i) => {
      if (t && t.status === "ok") ok++;
      else if (t && t.details && t.details.error === "DeviceNotRegistered") dead.push(tokens[i]);
      else if (t) console.warn("[notify] push rejected", uid, t.message || t);
    });
    if (dead.length) {
      await userRef.set(
        { pushTokens: admin.firestore.FieldValue.arrayRemove(...dead) },
        { merge: true }
      );
    }
    return ok;
  } catch (err) {
    console.warn("[notify] sendToUser failed", uid, err);
    return 0;
  }
}

module.exports = { sendToUser, isExpoToken };
