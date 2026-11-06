package dev.omo.doriface;

import android.graphics.Color;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * {@code DorifaceShell}: the page hands the shell its background, as it does to the desktop app, so the status and
 * navigation bars around the web view take the theme in view and their icons stay readable on it.
 */
@CapacitorPlugin(name = "DorifaceShell")
public class DorifaceShellPlugin extends Plugin {
    @PluginMethod
    public void setBackground(PluginCall call) {
        String css = call.getString("color", "");
        int color;
        try {
            color = Color.parseColor(css);
        } catch (IllegalArgumentException notAColor) {
            call.reject("not a #rrggbb color: " + css);
            return;
        }
        // Rec. 709 luma: a background above the middle takes dark icons.
        boolean light = (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) > 127.5;
        getActivity()
            .runOnUiThread(() -> {
                Window window = getActivity().getWindow();
                View decor = window.getDecorView();
                decor.setBackgroundColor(color);
                WindowInsetsControllerCompat bars = new WindowInsetsControllerCompat(window, decor);
                bars.setAppearanceLightStatusBars(light);
                bars.setAppearanceLightNavigationBars(light);
                call.resolve();
            });
    }
}
