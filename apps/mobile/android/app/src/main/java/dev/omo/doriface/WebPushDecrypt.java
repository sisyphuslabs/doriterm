package dev.omo.doriface;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens one RFC 8291 {@code aes128gcm} body (RFC 8188, a single record), as a browser does: only the holder of the
 * subscription's private key and auth secret can. The host pads every notice to one 128-byte record.
 */
public final class WebPushDecrypt {
    private WebPushDecrypt() {}

    public static ECParameterSpec p256() throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    /** An uncompressed P-256 point (65 bytes, 0x04 first) as a public key. */
    public static PublicKey publicKey(byte[] raw) throws GeneralSecurityException {
        if (raw.length != 65 || raw[0] != 4) throw new GeneralSecurityException("not an uncompressed P-256 key");
        ECPoint point = new ECPoint(
            new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)),
            new BigInteger(1, Arrays.copyOfRange(raw, 33, 65))
        );
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, p256()));
    }

    private static byte[] hmac(byte[] key, byte[]... parts) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] part : parts) mac.update(part);
        return mac.doFinal();
    }

    private static byte[] ascii(String text) {
        return text.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    }

    /** The plaintext, without its delimiter and padding; throws on any body this subscription cannot open. */
    public static byte[] decrypt(byte[] body, PrivateKey uaPrivate, byte[] uaPublic, byte[] authSecret)
        throws GeneralSecurityException {
        if (body.length < 21 + 65 + 16) throw new GeneralSecurityException("body too short");
        byte[] salt = Arrays.copyOfRange(body, 0, 16);
        int recordSize = ByteBuffer.wrap(body, 16, 4).getInt();
        int idLength = body[20] & 0xff;
        if (idLength != 65) throw new GeneralSecurityException("the key id is not a P-256 key");
        byte[] senderPublic = Arrays.copyOfRange(body, 21, 21 + idLength);
        byte[] sealed = Arrays.copyOfRange(body, 21 + idLength, body.length);
        if (recordSize < sealed.length) throw new GeneralSecurityException("more than one record");

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(uaPrivate);
        agreement.doPhase(publicKey(senderPublic), true);
        byte[] ecdhSecret = agreement.generateSecret();

        byte[] prkKey = hmac(authSecret, ecdhSecret);
        byte[] ikm = hmac(prkKey, ascii("WebPush: info\0"), uaPublic, senderPublic, new byte[] { 1 });
        byte[] prk = hmac(salt, ikm);
        byte[] cek = Arrays.copyOf(hmac(prk, ascii("Content-Encoding: aes128gcm\0"), new byte[] { 1 }), 16);
        byte[] nonce = Arrays.copyOf(hmac(prk, ascii("Content-Encoding: nonce\0"), new byte[] { 1 }), 12);

        Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
        aes.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
        byte[] padded = aes.doFinal(sealed);
        // RFC 8188 section 2: the delimiter is the last non-zero octet; zero padding may follow it.
        int end = padded.length - 1;
        while (end >= 0 && padded[end] == 0) end--;
        if (end < 0 || padded[end] != 2) throw new GeneralSecurityException("no last-record delimiter");
        return Arrays.copyOf(padded, end);
    }
}
