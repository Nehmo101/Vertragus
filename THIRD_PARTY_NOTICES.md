# Third-Party Notices

Vertragus is distributed under the MIT License (see `LICENSE`). It bundles or
optionally depends on third-party components under their own licenses. This file
records notices that require attribution or that carry obligations beyond MIT.

## web-push — Mozilla Public License 2.0 (MPL-2.0)

The optional push-notification feature uses [`web-push`](https://github.com/web-push-libs/web-push),
which is licensed under the **Mozilla Public License, v. 2.0**. A copy of the MPL-2.0
is available at https://mozilla.org/MPL/2.0/.

MPL-2.0 is a file-level (weak) copyleft license and is compatible with this
project's MIT license for distribution. Obligations:

- Vertragus uses `web-push` unmodified, as an optional dependency, without
  incorporating or altering its source files. If any MPL-2.0-covered source
  file is modified, that file's source must be made available under the MPL-2.0.
- This notice preserves attribution for `web-push` as required by the MPL-2.0.

No other bundled dependency imposes copyleft obligations; the remaining optional
runtime dependencies (`ws`, `qrcode`) and the core dependencies are MIT/ISC/BSD
or Apache-2.0 licensed.
