/* Stampd — Firebase App Check (shared by every page)
 *
 * WHY THIS FILE EXISTS
 * App Check makes Firestore and the Cloud Functions able to tell "this came
 * from the real Stampd website" from "this came from a script someone wrote".
 * It does NOT block anything on its own — enforcement is a separate switch in
 * the Firebase console, and it must stay OFF until the metrics there show the
 * real traffic is sending tokens. See the deploy notes.
 *
 * TO ACTIVATE: paste the reCAPTCHA Enterprise site key below.
 * Until then this file does nothing at all, deliberately — a wrong or missing
 * key must never take the live site down.
 */

const APPCHECK_SITE_KEY = "6Lf35-ctAAAAAG-g2PJfmWPhumYN1h7XLHVbwKSi";

const SDK = "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js";

export async function startAppCheck(app) {
  if (!APPCHECK_SITE_KEY || APPCHECK_SITE_KEY.startsWith("REPLACE_WITH")) {
    return null;                       // not configured yet — stay silent
  }
  try {
    const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import(SDK);
    return initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
  } catch (err) {
    // Never let App Check break the page. Worst case we send no token, which
    // is exactly what happens today.
    console.warn("[Stampd] App Check did not start:", err);
    return null;
  }
}

/** The site key, or null while it is still the placeholder.
 *  Used by vendor-login.html, which is on the older compat SDK. */
export function appCheckSiteKey() {
  if (!APPCHECK_SITE_KEY || APPCHECK_SITE_KEY.startsWith("REPLACE_WITH")) return null;
  return APPCHECK_SITE_KEY;
}
