"use strict";

// ─────────────────────────────────────────────────────────────
//  PIN generation — shared scheme.
//
//  The SAME algorithm is implemented in the app at
//  StampdApp/constants/pin.ts. If you change one, change both,
//  or vendors will see a PIN the server rejects.
//
//  A PIN is derived from the vendor's secret plus a time counter.
//  Nothing is stored or transmitted: both ends compute it from
//  the clock, so a vendor's device shows the right PIN even with
//  no connection.
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");

const DEFAULT_INTERVAL_SECONDS = 86400; // daily

function counterFor(epochSeconds, intervalSeconds) {
  return Math.floor(epochSeconds / intervalSeconds);
}

function pinForCounter(secret, counter) {
  const mac = crypto
    .createHmac("sha256", String(secret))
    .update(String(counter))
    .digest("hex");
  const slice = mac.slice(-8);
  const num = parseInt(slice, 16) % 10000;
  return String(num).padStart(4, "0");
}

// Current PIN plus the previous window, so a PIN typed just as it
// flips is still accepted.
function validPins(secret, intervalSeconds, epochSeconds) {
  const iv = intervalSeconds || DEFAULT_INTERVAL_SECONDS;
  const c = counterFor(epochSeconds, iv);
  return [pinForCounter(secret, c), pinForCounter(secret, c - 1)];
}

function newSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function newStaticPin() {
  // Avoid 0000 and obvious sequences.
  const banned = new Set(["0000", "1111", "2222", "3333", "4444", "5555",
    "6666", "7777", "8888", "9999", "1234", "4321", "0123"]);
  let pin;
  do {
    pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  } while (banned.has(pin));
  return pin;
}

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  counterFor,
  pinForCounter,
  validPins,
  newSecret,
  newStaticPin,
};
