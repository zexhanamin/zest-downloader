# Zest Downloader — Android

The phone version of Zest: multi-connection downloads with real pause/resume,
video from YouTube, Instagram, TikTok and six more sites through yt-dlp, and
a built-in browser that catches every download and puts a Download button on
videos.

Kotlin + Jetpack Compose, `minSdk 26` (Android 8), `targetSdk 35`.

## How links get into Zest

| From | How |
|---|---|
| Any app (YouTube, Instagram, TikTok, Chrome…) | **Share → Zest** opens a quality picker over that app |
| Zest's browser tab | Every file download is caught; videos get a **Download** button on the player |
| Anywhere | Copy a link, open Zest — it offers to download it |
| File links | "Open with Zest" starts the download directly |
| YouTube, Instagram, TikTok, Facebook, X, Reddit, browsers | The **floating download button** on the screen's edge (below) |

## The floating download button

While a video app or a browser is open, a small Zest tab rests on the edge of
the screen. Touch it once and it slides out; touch it again and the quality
picker opens for the video on screen. It tucks itself back after a few
seconds, and can be dragged up and down.

- **In a browser** it reads the address bar.
- **In an app** it presses the app's own Share button, then picks Zest in the
  share sheet: directly if Zest is listed, otherwise through "Copy link"
  (Zest reads the link once its sheet is in front), otherwise through "More".

Turn it on or off in **Settings → Floating download button**. It runs as an
Android accessibility service, which the user has to switch on themselves in
Accessibility → Installed apps → Zest; Android does not let an app do that on
its own. Zest uses that permission only to see which app is in front, to read
a browser's address bar, and to press that app's Share and Copy link buttons.
It reads nothing else and keeps nothing. On Android 13 and later, a sideloaded
app's accessibility switch can be greyed out until App info → ⋮ → **Allow
restricted settings**.

Mobile Chrome runs no extensions, so this button, the share sheet and the
built-in browser are how Zest reaches videos on a phone.

## Building

Everything the build needs lives in `.toolchain/` (git-ignored): JDK 17,
the Android SDK and Gradle's cache.

```bash
cd android
export JAVA_HOME="$PWD/.toolchain/jdk"
export GRADLE_USER_HOME="$PWD/.toolchain/gradle-home"
./gradlew assembleRelease
```

APKs land in `app/build/outputs/apk/release/` — one per CPU family plus a
universal one. `arm64-v8a` is right for almost every phone from the last
several years.

Release signing reads `keystore/keystore.properties` (git-ignored). **Back up
the keystore** — an APK signed with a different key cannot update one that
is already installed.

## Not on the Play Store

Google Play, like Apple's App Store, rejects apps that download from YouTube.
Zest ships as an APK on GitHub Releases, the way NewPipe and Seal do.
