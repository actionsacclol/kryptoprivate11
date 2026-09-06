# Publishing

## Pushing this to a new GitHub repo

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

That is all the setup there is. `.github/workflows/release.yml` is already in
the repo, so the first push starts three build jobs — Windows, macOS and
Linux — and about fifteen minutes later the installers are on the run's page
under **Actions → the run → Artifacts**, with a SHA-256 checksum beside each.

Nothing else needs enabling. Actions is on by default for a new repo, and the
workflow needs no secrets to produce unsigned builds.

## Cutting a release

```bash
npm version 1.0.0 --no-git-tag-version   # edits package.json
git commit -am "1.0.0"
git tag v1.0.0
git push origin main --tags
```

A tag starting with `v` runs the same three builds and then creates a **draft**
GitHub Release with every installer and checksum attached. It is a draft on
purpose: download one, install it, and only then press publish.

## Why three runners

The main process is compiled to V8 bytecode, and V8 only accepts bytecode
built by a matching version on matching hardware. A macOS installer therefore
cannot be produced on Windows — the app would install and then die at startup
with `cachedDataRejected`. Each platform is built on its own runner, and
`npm run dist` refuses to package a mismatch rather than shipping one.

## What is NOT done for you

**Code signing.** These builds are unsigned:

- **Windows** shows a SmartScreen warning ("Windows protected your PC") that
  users must click through. Fixing it needs a code-signing certificate,
  around $200–400 a year, and reputation builds over time.
- **macOS** is worse: Gatekeeper refuses to open an unsigned app at all
  without the user right-clicking and confirming. Fixing it needs an Apple
  Developer account ($99/year), a Developer ID certificate, and notarisation.

The bottom of the workflow file lists exactly which secrets to add for each,
and the one line to remove when the macOS certificate is in place.

For a trading app that holds a private key, this is worth doing before any
wide release. An unsigned installer is exactly what a careful user should
refuse to run, and telling people to click past a security warning is a habit
you do not want to teach your own users.

**Updates.** There is no updater and no version check yet. Someone on an old
build has no way to learn a new one exists.

**macOS and Linux are untested.** The packaging config and icons are in place
and the workflow will build them, but no one has yet installed and run either.
Treat the first builds as candidates, not releases.
