/**
 * VPN detection and configuration for Cast
 *
 * Supports Tailscale for exposing Cast on VPN networks.
 * Extensible to other VPNs (ZeroTier, Nebula, etc.) in the future.
 */

import commandExists from "command-exists";
import { execSync } from "child_process";

export interface TailscaleInfo {
  installed: boolean;
  connected?: boolean;
  ip?: string;
  hostname?: string;
}

export interface VpnConfig {
  bindHost: string;
  vpnUrl?: string;
}

/**
 * Detect Tailscale installation and connection status.
 * Returns IP and hostname if connected.
 */
export async function getTailscaleInfo(): Promise<TailscaleInfo> {
  // Check if tailscale CLI exists
  try {
    await commandExists("tailscale");
  } catch {
    return { installed: false };
  }

  // Check if connected and get info
  try {
    const ip = execSync("tailscale ip -4", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const statusJson = execSync("tailscale status --json", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const status = JSON.parse(statusJson);
    const hostname = status.Self?.DNSName?.replace(/\.$/, ""); // Remove trailing dot
    return { installed: true, connected: true, ip, hostname };
  } catch {
    return { installed: true, connected: false };
  }
}

/**
 * Supported VPN providers
 */
export const SUPPORTED_VPNS = ["tailscale"] as const;
export type VpnProvider = (typeof SUPPORTED_VPNS)[number];

/**
 * Check if a VPN provider is supported
 */
export function isSupportedVpn(vpn: string): vpn is VpnProvider {
  return SUPPORTED_VPNS.includes(vpn as VpnProvider);
}

/**
 * Configure VPN settings based on provider.
 * Returns bind host and VPN URL for display.
 */
export async function configureVpn(
  provider: string,
  port: number
): Promise<{ ok: true; config: VpnConfig } | { ok: false; error: string }> {
  if (!isSupportedVpn(provider)) {
    return {
      ok: false,
      error: `Unknown VPN: ${provider}\n\nSupported VPNs: ${SUPPORTED_VPNS.join(", ")}\n\nOr run without --vpn to bind to localhost only.`,
    };
  }

  if (provider === "tailscale") {
    const info = await getTailscaleInfo();

    if (!info.installed) {
      return {
        ok: false,
        error: `Tailscale not found

The --vpn tailscale option requires Tailscale to be installed.
Install it from: https://tailscale.com/download

Or run without --vpn to bind to localhost only.`,
      };
    }

    if (!info.connected) {
      return {
        ok: false,
        error: `Tailscale not connected

Tailscale is installed but not connected to a tailnet.
Connect with: tailscale up

Or run without --vpn to bind to localhost only.`,
      };
    }

    // Build VPN URL - prefer hostname, fallback to IP
    const vpnHost = info.hostname || info.ip;
    const vpnUrl = vpnHost ? `http://${vpnHost}:${port}` : undefined;

    return {
      ok: true,
      config: {
        bindHost: "0.0.0.0",
        vpnUrl,
      },
    };
  }

  // Shouldn't reach here due to isSupportedVpn check
  return {
    ok: false,
    error: `VPN provider ${provider} not implemented`,
  };
}

/**
 * Check VPN status for --doctor output
 */
export async function checkVpnForDoctor(requestedVpn?: string): Promise<string[]> {
  const lines: string[] = [];
  const info = await getTailscaleInfo();

  if (requestedVpn === "tailscale" || info.installed) {
    if (!info.installed) {
      lines.push("- Tailscale not installed (required for --vpn tailscale)");
    } else if (!info.connected) {
      lines.push("- Tailscale installed but not connected");
      lines.push("  Run: tailscale up");
    } else {
      lines.push(`- Tailscale connected (${info.hostname || info.ip})`);
    }
  } else {
    lines.push("- Tailscale not installed (optional)");
  }

  return lines;
}
