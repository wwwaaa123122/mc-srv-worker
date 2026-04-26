export function parseMCAddress(input) {
  let [host, port] = input.split(":");
  if (!port) port = "25565";

  return { host, port };
}

export function generateSubdomain(prefix) {
  if (prefix) return prefix;

  return "mc-" + Math.random().toString(36).substring(2, 8);
}

export function isIP(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host);
}
