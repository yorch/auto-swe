# Licensing

auto-swe is distributed under the **Functional Source License, Version 1.1, MIT
Future License (FSL-1.1-MIT)**. See [`LICENSE`](./LICENSE) for the full, governing
text — this page is a plain-language summary and does not override it.

- **SPDX-style identifier:** `LicenseRef-FSL-1.1-MIT` (FSL is not on the SPDX
  license list, so it is referenced rather than a standard SPDX id; `package.json`
  uses `"SEE LICENSE IN LICENSE"`).
- **Copyright:** © 2026 Jorge Barnaby (the "Licensor").

## What this means

FSL-1.1-MIT is a **source-available** (not OSI "open source") license. The grant is
broad: you may do anything **except** compete with the project, and each release
turns into MIT after two years. In plain terms:

- ✅ **You may** use, copy, modify, create derivative works, and self-host the
  software for any **Permitted Purpose** — which the license defines as *any
  purpose other than a Competing Use*. This explicitly includes **internal use
  (commercial or not)**, **non-commercial education**, **non-commercial research**,
  and **professional services** you provide to someone else who is using the
  software under these terms.
- ✅ **You may redistribute** copies, modifications, and derivatives — provided you
  include these terms (or a link to them) and keep the existing copyright notices
  intact.
- ❌ **You may not** put it to a **Competing Use** — i.e. make the software (or a
  derivative) available to others in a commercial product or service that
  substitutes for it, substitutes for another product/service the Licensor offers
  using it, or offers the same or substantially similar functionality. In
  practice: you cannot resell it or run it as a competing hosted/managed SaaS.
- ⏳ **Two-year fuse:** each released version automatically converts to the
  permissive **MIT License** on the **second anniversary** of *that version's*
  release date. After that date, that specific version may be used under MIT with
  no restrictions (newer versions remain under FSL until their own fuse expires).

If you want to use the software for a Competing Use before its MIT conversion,
contact the Licensor about a separate commercial license (see below).

## Quick reference

| Scenario | Allowed? |
| --- | --- |
| Run it inside your company for your own engineering work | ✅ Yes (internal use) |
| Modify it and self-host the modified version internally | ✅ Yes |
| Use it while delivering consulting to a client who runs it under FSL | ✅ Yes (professional services) |
| Fork it on GitHub and keep your changes under FSL | ✅ Yes (redistribution with notices) |
| Offer it (or a near-clone) as a paid hosted/managed SaaS | ❌ No — Competing Use |
| Resell it as a product that substitutes for auto-swe | ❌ No — Competing Use |
| Use a release that is more than two years old, under MIT | ✅ Yes (post-conversion) |

> Edge cases (what counts as "substantially similar functionality," whether a
> particular offering competes) are governed by the [`LICENSE`](./LICENSE) text, not
> this table. When in doubt, ask.

## Getting a commercial license

For a Competing Use, or any use the FSL grant does not cover, you need a separate
commercial license from the Licensor. Reach out by **opening a GitHub issue** on
this repository (or contacting the copyright holder directly) describing the
intended use; licensing terms are handled case by case.
