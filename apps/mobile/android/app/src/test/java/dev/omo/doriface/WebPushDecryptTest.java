package dev.omo.doriface;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.spec.ECPrivateKeySpec;
import java.util.Base64;
import org.junit.Test;

/** RFC 8291 Appendix A, and a body the host's own sender made with those keys, opened by the Android app's code. */
public class WebPushDecryptTest {
    private static final String UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    private static final String UA_PUBLIC =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    private static final String AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
    private static final String RFC_BODY =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_" +
        "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
    /** {@code encryptPushPayload} of the notice below with Appendix A's sender and salt, padded to 128 bytes. */
    private static final String HOST_BODY =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3" +
        "jl7A_e3c0XWOO2NE-e6aw4m2R-3ETFlJp0K-ik0lk9oJvRatX-HHRhCyyAFBH33BLGk0gQAOtarUe7yPE39Mmbfizqv2-w1c1OXqbTf7sxRShd" +
        "6Pst32VYr9h3m7J8HmkaN7UBxC6hYhpHkB1rQatb8WiRCUhEqP1_K7C8ugM_Wf9IBNcLDisJg4egEuay2mymz6k";
    private static final String HOST_NOTICE = "{\"v\":1,\"n\":\"AAAAAAAAAAAAAAAAAAAAAA\",\"k\":\"permission\",\"h\":\"abcdefghijklmnopqrstuvwxyz\"}";

    private static byte[] b64(String text) {
        return Base64.getUrlDecoder().decode(text);
    }

    private static PrivateKey uaPrivate() throws GeneralSecurityException {
        return KeyFactory.getInstance("EC").generatePrivate(
            new ECPrivateKeySpec(new BigInteger(1, b64(UA_PRIVATE)), WebPushDecrypt.p256())
        );
    }

    private static String open(String body) throws GeneralSecurityException {
        return new String(WebPushDecrypt.decrypt(b64(body), uaPrivate(), b64(UA_PUBLIC), b64(AUTH)), StandardCharsets.UTF_8);
    }

    @Test
    public void appendixA() throws GeneralSecurityException {
        assertEquals("When I grow up, I want to be a watermelon", open(RFC_BODY));
    }

    @Test
    public void theHostsPaddedNotice() throws GeneralSecurityException {
        String plain = open(HOST_BODY);
        assertEquals(HOST_NOTICE, plain);
        Notice notice = Notice.parse(plain);
        assertEquals("permission", notice.kind);
        assertEquals("/?notice=AAAAAAAAAAAAAAAAAAAAAA&host=abcdefghijklmnopqrstuvwxyz&answer=allow", notice.url("allow"));
        assertEquals("An agent is asking for permission.", notice.body());
    }

    @Test
    public void anotherAuthSecretOpensNothing() {
        byte[] other = b64(AUTH);
        other[0] ^= 1;
        assertThrows(GeneralSecurityException.class, () ->
            WebPushDecrypt.decrypt(b64(HOST_BODY), uaPrivate(), b64(UA_PUBLIC), other)
        );
    }

    @Test
    public void aTamperedBodyOpensNothing() {
        byte[] body = b64(HOST_BODY);
        body[body.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> WebPushDecrypt.decrypt(body, uaPrivate(), b64(UA_PUBLIC), b64(AUTH)));
    }

    @Test
    public void onlyTheHostsExactNoticeParses() {
        assertNull(Notice.parse("{\"v\":1,\"n\":\"AAAAAAAAAAAAAAAAAAAAAA\",\"k\":\"done\",\"h\":\"abcdefghijklmnopqrstuvwxyz\",\"x\":1}"));
        assertNull(Notice.parse("{\"v\":2,\"n\":\"AAAAAAAAAAAAAAAAAAAAAA\",\"k\":\"done\",\"h\":\"abcdefghijklmnopqrstuvwxyz\"}"));
        assertNull(Notice.parse("{\"v\":1,\"n\":\"short\",\"k\":\"done\",\"h\":\"abcdefghijklmnopqrstuvwxyz\"}"));
        assertArrayEquals(new String[] { "done" }, new String[] { Notice.parse(HOST_NOTICE.replace("permission", "done")).kind });
    }
}
