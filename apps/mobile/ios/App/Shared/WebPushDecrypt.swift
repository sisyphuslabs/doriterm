import CryptoKit
import Foundation

/// Opens one RFC 8291 `aes128gcm` body (RFC 8188, a single record) as a browser does: only the holder of the
/// subscription's private key and auth secret can. The host pads every notice to one 128-byte record.
enum WebPushDecrypt {
    enum Failure: Error { case malformed, notOpened, noDelimiter }

    private static func hmac(_ key: Data, _ parts: Data...) -> Data {
        var mac = HMAC<SHA256>(key: SymmetricKey(data: key))
        for part in parts { mac.update(data: part) }
        return Data(mac.finalize())
    }

    static func decrypt(_ body: Data, privateKey: P256.KeyAgreement.PrivateKey, auth: Data) throws -> Data {
        let bytes = [UInt8](body)
        guard bytes.count >= 21 + 65 + 16, bytes[20] == 65 else { throw Failure.malformed }
        let salt = Data(bytes[0..<16])
        let recordSize = bytes[16..<20].reduce(0) { ($0 << 8) | Int($1) }
        let senderRaw = Data(bytes[21..<86])
        let sealed = Data(bytes[86...])
        guard recordSize >= sealed.count else { throw Failure.malformed }

        let sender = try P256.KeyAgreement.PublicKey(x963Representation: senderRaw)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: sender)
        let ecdh = shared.withUnsafeBytes { Data($0) }
        let uaPublic = privateKey.publicKey.x963Representation

        let prkKey = hmac(auth, ecdh)
        let ikm = hmac(prkKey, Data("WebPush: info\u{0}".utf8), uaPublic, senderRaw, Data([1]))
        let prk = hmac(salt, ikm)
        let cek = hmac(prk, Data("Content-Encoding: aes128gcm\u{0}".utf8), Data([1])).prefix(16)
        let nonce = hmac(prk, Data("Content-Encoding: nonce\u{0}".utf8), Data([1])).prefix(12)

        guard sealed.count > 16 else { throw Failure.malformed }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: sealed.prefix(sealed.count - 16),
            tag: sealed.suffix(16)
        )
        let padded: Data
        do { padded = try AES.GCM.open(box, using: SymmetricKey(data: cek)) } catch { throw Failure.notOpened }
        // RFC 8188 section 2: the delimiter is the last non-zero octet; zero padding may follow it.
        guard let end = padded.lastIndex(where: { $0 != 0 }), padded[end] == 2 else { throw Failure.noDelimiter }
        return padded[padded.startIndex..<end]
    }
}
