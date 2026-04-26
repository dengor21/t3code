import type { DesktopAppBranding } from "@t3tools/contracts";
import {
  APP_BASE_NAME as DEFAULT_APP_BASE_NAME,
  formatDisplayName,
} from "@t3tools/shared/branding";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();

export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? DEFAULT_APP_BASE_NAME;
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ?? (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ?? formatDisplayName(APP_BASE_NAME, APP_STAGE_LABEL);
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
