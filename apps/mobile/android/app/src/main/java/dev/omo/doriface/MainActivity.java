package dev.omo.doriface;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DorifacePushPlugin.class);
        registerPlugin(DorifaceShellPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
