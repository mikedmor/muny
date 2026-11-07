/**
 * Whether an assistant can connect to Muny at this address. Without SSL, MCP
 * connections don't work reliably and the token travels unencrypted. An address on
 * this same machine never leaves it, so it's the one exception.
 */
export function mcpAddressIsSafe(address: string): boolean {
  const { protocol, hostname } = new URL(address);
  return (
    protocol === "https:" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}
