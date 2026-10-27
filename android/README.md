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

Android does not let one app draw buttons inside another app, and mobile
Chrome runs no extensions — so the share sheet and the built-in browser are
how this works on a phone.

Zest asks for no sensitive permissions — no Accessibility, SMS or
notification access — so Google Play Protect lets it install from a browser
or file manager everywhere.

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
