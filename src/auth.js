const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 16 位 CSPRNG 授权码（约 80 bit 熵）。历史记录的短授权码仍可通过 verifyAuthCode 校验。 */
export function generateAuthCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let code = "";
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

export function verifyAuthCode(stored, input) {
  const a = String(stored ?? "");
  const b = String(input ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
