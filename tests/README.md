# Stampd server tests

Checks the Cloud Functions logic (stamping, offer switching, card expiry,
reward alerts) and billing (Stripe replaced by a fake — nothing real is charged) against an in-memory stand-in for Firestore. No Firebase
project, emulator or internet needed.

    cd ~/Stampd/functions && npm install   # once
    cd ~/Stampd && node tests/run.js && node tests/billing.js

Expect `ALL PASSED`. Run before every `firebase deploy --only functions`.
