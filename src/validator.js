export function validateInput(input) {
  if (!input) return null;

  const parts = input.split(":");

  if (parts.length !== 2) return null;

  const host = parts[0].trim();
  const port = parseInt(parts[1]);

  if (!host || isNaN(port)) return null;

  if (port < 1 || port > 65535) return null;

  return { host, port };
}
