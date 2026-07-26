//! OS-backed encryption for secrets at rest.
//!
//! Replaces Electron's `safeStorage`. On Windows that was DPAPI underneath, so
//! this calls DPAPI directly — one fewer runtime between a token and the
//! keyring. Ciphertext is bound to the current user account: another user on
//! the same machine cannot decrypt it, and neither can the same file copied to
//! a different machine.
//!
//! The trait exists so [`crate::store::SecureStore`] can be tested without
//! touching the real keyring, and so a non-Windows backend can be dropped in
//! later without changing the store.

/// Encryption backend. Fallible by design: a machine with a broken or
/// unavailable keyring must degrade visibly rather than lose the token.
pub trait Crypto: Send + Sync {
    fn is_available(&self) -> bool;
    fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String>;
    fn decrypt(&self, cipher: &[u8]) -> Result<String, String>;
}

#[cfg(target_os = "windows")]
mod dpapi {
    use super::Crypto;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
    };
    use windows::core::PCWSTR;

    /// Never show a UI prompt: Periphery encrypts on a background thread and a
    /// modal from a tray app the user cannot see would be a hang.
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    pub struct DpapiCrypto;

    /// Copies a blob's bytes out and frees the memory DPAPI allocated for it.
    ///
    /// # Safety
    /// `blob` must be an output blob populated by a successful DPAPI call and
    /// not yet freed.
    unsafe fn take_blob(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if blob.pbData.is_null() {
            return Vec::new();
        }
        let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
        // LocalFree returns the handle back on failure; there is nothing
        // useful to do about a failed free, so the result is discarded.
        let _ = unsafe { LocalFree(Some(HLOCAL(blob.pbData as *mut _))) };
        bytes
    }

    impl Crypto for DpapiCrypto {
        fn is_available(&self) -> bool {
            // Availability is not a queryable property of DPAPI, so probe it:
            // a round trip is cheap and answers the question honestly.
            match self.encrypt("periphery-probe") {
                Ok(cipher) => self.decrypt(&cipher).is_ok_and(|s| s == "periphery-probe"),
                Err(_) => false,
            }
        }

        fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String> {
            let mut input = plain.as_bytes().to_vec();
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: input.len() as u32,
                pbData: input.as_mut_ptr(),
            };
            let mut out_blob = CRYPT_INTEGER_BLOB::default();

            unsafe {
                CryptProtectData(
                    &in_blob,
                    PCWSTR::null(),
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut out_blob,
                )
                .map_err(|e| format!("CryptProtectData failed: {e}"))?;
                Ok(take_blob(&out_blob))
            }
        }

        fn decrypt(&self, cipher: &[u8]) -> Result<String, String> {
            let mut input = cipher.to_vec();
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: input.len() as u32,
                pbData: input.as_mut_ptr(),
            };
            let mut out_blob = CRYPT_INTEGER_BLOB::default();

            unsafe {
                CryptUnprotectData(
                    &in_blob,
                    None,
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut out_blob,
                )
                .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;
                let bytes = take_blob(&out_blob);
                String::from_utf8(bytes).map_err(|e| format!("decrypted bytes are not UTF-8: {e}"))
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub use dpapi::DpapiCrypto;

/// Returns the platform's encryption backend.
pub fn default_crypto() -> Box<dyn Crypto> {
    #[cfg(target_os = "windows")]
    {
        Box::new(DpapiCrypto)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(UnavailableCrypto)
    }
}

/// Stand-in on platforms without a backend yet. It refuses rather than
/// pretending: `SecureStore` then stores in plaintext *and says so*, which is
/// the honest failure mode.
#[cfg(not(target_os = "windows"))]
pub struct UnavailableCrypto;

#[cfg(not(target_os = "windows"))]
impl Crypto for UnavailableCrypto {
    fn is_available(&self) -> bool {
        false
    }
    fn encrypt(&self, _plain: &str) -> Result<Vec<u8>, String> {
        Err("no OS encryption backend on this platform".into())
    }
    fn decrypt(&self, _cipher: &[u8]) -> Result<String, String> {
        Err("no OS encryption backend on this platform".into())
    }
}

#[cfg(test)]
pub mod test_support {
    use super::Crypto;

    /// Reversible, obviously-not-secret transform. Ciphertext differs from
    /// plaintext so a test can prove the store wrote the encrypted form.
    pub struct FakeCrypto {
        pub available: bool,
    }

    impl Crypto for FakeCrypto {
        fn is_available(&self) -> bool {
            self.available
        }
        fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String> {
            if !self.available {
                return Err("unavailable".into());
            }
            Ok(plain.bytes().map(|b| b ^ 0x5a).collect())
        }
        fn decrypt(&self, cipher: &[u8]) -> Result<String, String> {
            if !self.available {
                return Err("unavailable".into());
            }
            String::from_utf8(cipher.iter().map(|b| b ^ 0x5a).collect())
                .map_err(|e| e.to_string())
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trips_a_secret() {
        let crypto = DpapiCrypto;
        let cipher = crypto.encrypt("glpat-secret-token").expect("encrypt");
        assert_ne!(
            cipher, b"glpat-secret-token",
            "ciphertext must not be the plaintext"
        );
        assert_eq!(crypto.decrypt(&cipher).expect("decrypt"), "glpat-secret-token");
    }

    #[test]
    fn dpapi_reports_itself_available_on_a_normal_desktop() {
        assert!(DpapiCrypto.is_available());
    }

    #[test]
    fn garbage_ciphertext_is_an_error_not_a_panic() {
        assert!(DpapiCrypto.decrypt(b"not actually dpapi output").is_err());
    }

    #[test]
    fn round_trips_multibyte_text() {
        let crypto = DpapiCrypto;
        let secret = "clé-secrète-🔐";
        let cipher = crypto.encrypt(secret).expect("encrypt");
        assert_eq!(crypto.decrypt(&cipher).expect("decrypt"), secret);
    }
}
