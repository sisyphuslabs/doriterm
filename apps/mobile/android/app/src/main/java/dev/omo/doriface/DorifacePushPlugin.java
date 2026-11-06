package dev.omo.doriface;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/** {@code DorifacePush}: the web app's push registrar in the Android app (apps/web/src/native/shell.ts). */
@CapacitorPlugin(
    name = "DorifacePush",
    permissions = { @Permission(alias = "receive", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class DorifacePushPlugin extends Plugin {
    private static String launchUrl;

    static void saveToken(Context context, String token) {
        NoticeKeys.prefs(context).edit().putString("token", token).apply();
    }

    /** A tapped notification: kept for {@code takeLaunchTap} until the page asks, and sent to a page that listens. */
    void tapped(Intent intent) {
        String url = intent == null ? null : intent.getStringExtra(NoticeMessagingService.EXTRA_URL);
        if (url == null) return;
        // Only this app's own notification intents: the launcher activity is exported, so any app can start it.
        String nonce = NoticeMessagingService.nonce(getContext());
        if (!nonce.equals(intent.getStringExtra(NoticeMessagingService.EXTRA_NONCE))) return;
        // An action button does not dismiss its notification by itself; the notice is handled once the app has it.
        String tag = intent.getStringExtra(NoticeMessagingService.EXTRA_TAG);
        if (tag != null) NotificationManagerCompat.from(getContext()).cancel(tag, NoticeMessagingService.NOTICE_ID);
        intent.removeExtra(NoticeMessagingService.EXTRA_URL);
        if (hasListeners("noticeTap")) {
            JSObject tap = new JSObject();
            tap.put("url", url);
            notifyListeners("noticeTap", tap);
        } else launchUrl = url;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        tapped(intent);
    }

    @Override
    public void load() {
        tapped(getActivity().getIntent());
    }

    private String receive() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
        PermissionState state = getPermissionState("receive");
        return state == PermissionState.GRANTED ? "granted" : state == PermissionState.DENIED ? "denied" : "default";
    }

    private void answerPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("receive", receive());
        call.resolve(result);
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        answerPermission(call);
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (receive().equals("granted")) answerPermission(call);
        else requestPermissionForAlias("receive", call, "permissionAnswered");
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        answerPermission(call);
    }

    private JSObject registration(String token) throws Exception {
        NoticeKeys keys = NoticeKeys.load(getContext());
        JSObject out = new JSObject();
        out.put("platform", "android");
        out.put("token", token);
        out.put("sandbox", false);
        out.put("p256dh", NoticeKeys.b64url(keys.publicKey));
        out.put("auth", NoticeKeys.b64url(keys.auth));
        return out;
    }

    @PluginMethod
    public void register(PluginCall call) {
        if (FirebaseApp.getApps(getContext()).isEmpty()) {
            call.reject("This build has no Firebase project, so it cannot receive notifications.", "unconfigured");
            return;
        }
        FirebaseMessaging.getInstance()
            .getToken()
            .addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null) {
                    call.reject("FCM gave no token", "no-token");
                    return;
                }
                try {
                    // Keys first: a recovery inside load() clears the store, and must not erase the token saved here.
                    NoticeKeys.load(getContext());
                    saveToken(getContext(), task.getResult());
                    call.resolve(registration(task.getResult()));
                } catch (Exception error) {
                    call.reject("The notification keys could not be made", "keys", error);
                }
            });
    }

    @PluginMethod
    public void current(PluginCall call) {
        JSObject out = new JSObject();
        try {
            // Keys first: keys that had to be made again come with no token, so the page subscribes afresh instead of
            // keeping a host subscription that still holds the old keys.
            NoticeKeys.load(getContext());
            String token = NoticeKeys.prefs(getContext()).getString("token", null);
            out.put("registration", token == null ? null : registration(token));
            call.resolve(out);
        } catch (Exception error) {
            call.reject("The notification keys could not be read", "keys", error);
        }
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        NoticeKeys.prefs(getContext()).edit().remove("token").apply();
        if (!FirebaseApp.getApps(getContext()).isEmpty()) FirebaseMessaging.getInstance().deleteToken();
        call.resolve();
    }

    @PluginMethod
    public void takeLaunchTap(PluginCall call) {
        JSObject out = new JSObject();
        if (launchUrl == null) out.put("tap", null);
        else {
            JSObject tap = new JSObject();
            tap.put("url", launchUrl);
            out.put("tap", tap);
            launchUrl = null;
        }
        call.resolve(out);
    }
}
