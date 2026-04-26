export function generateAuthCode() {
  return Math.random().toString(36).substring(2, 10);
}

export function verifyAuthCode(stored, input) {
  return stored === input;
}
