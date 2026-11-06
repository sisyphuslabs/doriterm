package dev.omo.doriface;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;

/**
 * A notice from the push bridge (#705), with the app closed or open: FCM hands over the host's ciphertext as {@code p},
 * the app opens it with its own keys and shows the same fixed text the web app shows. A permission notice carries
 * Allow and Deny; both open the app, which answers once it is on screen, through the host's live-prompt check.
 */
public class NoticeMessagingService extends FirebaseMessagingService {
    static final String CHANNEL = "notices";
    static final String EXTRA_URL = "dev.omo.doriface.NOTICE_URL";
    static final String EXTRA_TAG = "dev.omo.doriface.NOTICE_TAG";
    static final String EXTRA_NONCE = "dev.omo.doriface.NOTICE_NONCE";
    /**
     * Rides on every notice intent this app makes; an intent from another app cannot know it. Made once and kept in the
     * app's private storage, so a notification posted before the process was killed still opens its pane when tapped.
     */
    static synchronized String nonce(Context context) {
        android.content.SharedPreferences prefs = context.getSharedPreferences("doriface-intents", Context.MODE_PRIVATE);
        String value = prefs.getString("nonce", null);
        if (value == null) {
            value = java.util.UUID.randomUUID().toString();
            prefs.edit().putString("nonce", value).commit();
        }
        return value;
    }
    static final int NOTICE_ID = 1;
    private static final String TAG = "doriface-push";

    @Override
    public void onNewToken(String token) {
        DorifacePushPlugin.saveToken(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String payload = message.getData().get("p");
        Notice notice = null;
        if (payload != null) {
            try {
                byte[] body = Base64.decode(payload, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
                notice = Notice.parse(new String(NoticeKeys.load(this).open(body), StandardCharsets.UTF_8));
            } catch (Exception error) {
                Log.w(TAG, "a notice could not be opened: " + error.getClass().getSimpleName());
            }
        }
        show(this, notice);
    }

    static void ensureChannel(Context context) {
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Agents", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("An agent asks for input or permission, finishes, or stops with an error.");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private static PendingIntent open(Context context, String url, String tag, int request) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_URL, url)
            .putExtra(EXTRA_TAG, tag)
            .putExtra(EXTRA_NONCE, nonce(context))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Every push shows a notification; one this app cannot open says so and opens the app. */
    static void show(Context context, Notice notice) {
        ensureChannel(context);
        int id = notice == null ? 0 : notice.id.hashCode();
        String tag = notice == null ? "doriface" : notice.id;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_doriface)
            .setColor(0xFF4A6EE0)
            .setContentTitle("doriface")
            .setContentText(notice == null ? "Open doriface to see what changed." : notice.body())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open(context, notice == null ? "/" : notice.url(null), tag, id * 3));
        if (notice != null && "permission".equals(notice.kind)) {
            builder.addAction(0, "Allow", open(context, notice.url("allow"), tag, id * 3 + 1));
            builder.addAction(0, "Deny", open(context, notice.url("deny"), tag, id * 3 + 2));
        }
        try {
            NotificationManagerCompat.from(context).notify(tag, NOTICE_ID, builder.build());
        } catch (SecurityException withdrawn) {
            Log.w(TAG, "notifications are not allowed for this app");
        }
    }
}
