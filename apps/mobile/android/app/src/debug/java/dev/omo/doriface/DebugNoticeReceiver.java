package dev.omo.doriface;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;

/**
 * Debug builds only (src/debug): feeds a bridge payload to the same open-and-show path FCM uses, so an emulator with
 * no Firebase project can show a real notice. `keys` logs the public half and the auth secret the host encrypts to;
 * `notice` takes the bridge's `p`.
 *
 * adb shell am broadcast -n dev.omo.doriface/.DebugNoticeReceiver -a dev.omo.doriface.DEBUG_KEYS
 * adb shell am broadcast -n dev.omo.doriface/.DebugNoticeReceiver -a dev.omo.doriface.DEBUG_NOTICE --es p <payload>
 */
public class DebugNoticeReceiver extends BroadcastReceiver {
    private static final String TAG = "doriface-push";

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            NoticeKeys keys = NoticeKeys.load(context);
            if ("dev.omo.doriface.DEBUG_KEYS".equals(intent.getAction())) {
                Log.i(TAG, "DEBUG_KEYS p256dh=" + NoticeKeys.b64url(keys.publicKey) + " auth=" + NoticeKeys.b64url(keys.auth));
                return;
            }
            String payload = intent.getStringExtra("p");
            byte[] body = Base64.decode(payload, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            Notice notice = Notice.parse(new String(keys.open(body), StandardCharsets.UTF_8));
            Log.i(TAG, "DEBUG_NOTICE " + (notice == null ? "unreadable" : notice.kind));
            NoticeMessagingService.show(context, notice);
        } catch (Exception error) {
            Log.w(TAG, "DEBUG_NOTICE failed: " + error);
            NoticeMessagingService.show(context, null);
        }
    }
}
