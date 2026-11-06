# @doriface/mobile

The iOS and Android apps (#199, #704): a Capacitor shell around the same `apps/web` build. The Noise/relay client, mesh pairing and the libghostty renderer run unchanged in the platform web view; only push and the shell around it are native.

## Android

```sh
bun install
bun run --cwd apps/mobile sync:android      # builds apps/web and copies it into android/
cd apps/mobile/android && ./gradlew assembleDebug testDebugUnitTest
```

Needs JDK 21 and an Android SDK with platform 36 (`ANDROID_HOME`). The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`.

Push (#705): the app registers with FCM, makes its own P-256 key and auth secret (sealed under an Android Keystore key), and subscribes on the host with an endpoint on the push bridge (`apps/push-bridge`). `NoticeMessagingService` opens each notice with those keys (`WebPushDecrypt`, RFC 8291) and shows the same fixed text the web app shows; a permission notice carries Allow and Deny, which open the app on the pane, where the page answers once it is visible.

A build without a Firebase project (`android/app/google-services.json`, an owner step) runs everything except push registration: Settings > Notifications says so. Debug builds carry `DebugNoticeReceiver`, which feeds a bridge payload to the same open-and-show path, so an emulator can show a real notice without FCM.

## iOS

Not in this tree yet: the iOS shell and its Notification Service Extension follow in a separate change under #704, built on macOS.
