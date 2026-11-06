package dev.omo.doriface;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The app's push subscription keys (RFC 8291): a P-256 key pair and a 16-byte auth secret, made once. They never
 * leave the device; the private half and the secret are stored sealed under an AES key held by the Android Keystore,
 * so they are unreadable outside this app.
 */
final class NoticeKeys {
    private static final String PREFS = "doriface-push";
    private static final String WRAP_ALIAS = "doriface-push-wrap";

    final PrivateKey privateKey;
    final byte[] publicKey;
    final byte[] auth;

    private NoticeKeys(PrivateKey privateKey, byte[] publicKey, byte[] auth) {
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.auth = auth;
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String b64url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static byte[] b64(String text) {
        return Base64.decode(text, Base64.NO_WRAP);
    }

    private static SecretKey wrapKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(WRAP_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(WRAP_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    private static String seal(byte[] plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey());
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(plain);
        byte[] out = Arrays.copyOf(iv, iv.length + sealed.length);
        System.arraycopy(sealed, 0, out, iv.length, sealed.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    private static byte[] open(String stored) throws Exception {
        byte[] all = b64(stored);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, all, 0, 12));
        return cipher.doFinal(all, 12, all.length - 12);
    }

    /** The stored keys, made and stored on first use. */
    static synchronized NoticeKeys load(Context context) throws Exception {
        SharedPreferences prefs = prefs(context);
        String sealedKey = prefs.getString("key", null);
        String sealedAuth = prefs.getString("auth", null);
        String pub = prefs.getString("pub", null);
        if (sealedKey != null && sealedAuth != null && pub != null) {
            try {
                PrivateKey privateKey = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(open(sealedKey)));
                return new NoticeKeys(privateKey, b64(pub), open(sealedAuth));
            } catch (Exception unopenable) {
                // Keys this device cannot open (restored from another device, a lost or unreadable wrap key, a corrupt
                // value): forget them, the token and the wrap key, so new ones are made below and the page subscribes
                // again with keys the host can encrypt to.
                prefs.edit().clear().commit();
                try {
                    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
                    store.load(null);
                    store.deleteEntry(WRAP_ALIAS);
                } catch (Exception ignored) {
                    // No entry to delete, or none readable: wrapKey() below makes a new one either way.
                }
            }
        }
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        byte[] raw = uncompressed((ECPublicKey) pair.getPublic());
        prefs
            .edit()
            .putString("key", seal(pair.getPrivate().getEncoded()))
            .putString("auth", seal(auth))
            .putString("pub", Base64.encodeToString(raw, Base64.NO_WRAP))
            .commit();
        return new NoticeKeys(pair.getPrivate(), raw, auth);
    }

    private static byte[] uncompressed(ECPublicKey key) {
        byte[] out = new byte[65];
        out[0] = 4;
        copyUnsigned(key.getW().getAffineX().toByteArray(), out, 1);
        copyUnsigned(key.getW().getAffineY().toByteArray(), out, 33);
        return out;
    }

    /** A BigInteger's bytes, right-aligned into 32: it may carry a sign byte or be shorter. */
    private static void copyUnsigned(byte[] value, byte[] out, int at) {
        int length = Math.min(value.length, 32);
        System.arraycopy(value, value.length - length, out, at + 32 - length, length);
    }

    byte[] open(byte[] body) throws GeneralSecurityException {
        return WebPushDecrypt.decrypt(body, privateKey, publicKey, auth);
    }
}
