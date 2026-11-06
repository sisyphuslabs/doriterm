package dev.omo.doriface;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.junit.Test;

/**
 * The push keys are sealed under a Keystore key that never leaves the device, so no backup or transfer may carry them:
 * a restored copy could never be opened and push would stay broken until the app's data is cleared (#810 review).
 */
public class BackupRulesTest {
    private static String read(String path) throws Exception {
        return new String(Files.readAllBytes(Paths.get(path)), java.nio.charset.StandardCharsets.UTF_8);
    }

    private static int count(String text, String needle) {
        int n = 0;
        for (int at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) n++;
        return n;
    }

    @Test
    public void theManifestNamesBothRuleSets() throws Exception {
        String manifest = read("src/main/AndroidManifest.xml");
        assertTrue(manifest.contains("android:fullBackupContent=\"@xml/backup_rules\""));
        assertTrue(manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""));
    }

    @Test
    public void everyPathOutExcludesThePushKeys() throws Exception {
        String exclude = "<exclude domain=\"sharedpref\" path=\"doriface-push.xml\" />";
        assertEquals(1, count(read("src/main/res/xml/backup_rules.xml"), exclude));
        String extraction = read("src/main/res/xml/data_extraction_rules.xml");
        assertEquals(2, count(extraction, exclude));
        assertTrue(extraction.indexOf("<cloud-backup>") < extraction.indexOf(exclude));
        assertTrue(extraction.contains("<device-transfer>"));
    }

    @Test
    public void thePreferencesFileIsTheOneTheKeysUse() throws Exception {
        assertTrue(read("src/main/java/dev/omo/doriface/NoticeKeys.java").contains("PREFS = \"doriface-push\""));
    }
}
