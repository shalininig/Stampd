# Stampd account emails (Firebase templates)

> **Superseded 15 Oct 2026.** Firebase refused the edit ("Email template updates are currently unavailable for this project"). Stampd now sends these emails itself: see `functions/accountEmails.js`. These files are kept for reference only.

Branded versions of the two emails Firebase sends for us. Added 15 Oct 2026 after testing showed the defaults looked bland and came from "noreply".

| File | Firebase template | Subject |
|---|---|---|
| `verify-email.html` | Authentication → Templates → **Email address verification** | Confirm your email for Stampd |
| `reset-password.html` | Authentication → Templates → **Password reset** | Reset your Stampd password |

For both templates:

- **Sender name:** Stampd
- **From:** noreply@stampd.co.nz
- **Reply to:** support@stampd.co.nz
- **Message:** paste the whole file. Firebase fills in `%DISPLAY_NAME%`, `%EMAIL%` and `%LINK%`.

To copy a file to the clipboard: `pbcopy < ~/Stampd/email-templates/verify-email.html`

The App Store and Google Play links only work once the apps are released.
