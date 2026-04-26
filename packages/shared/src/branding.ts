export const APP_BASE_NAME = "HAL";
export const APP_REPOSITORY_URL = "https://github.com/dengor21/t3code";
export const APP_REPOSITORY_RELEASES_URL = `${APP_REPOSITORY_URL}/releases`;

export function formatDisplayName(baseName: string, stageLabel: string): string {
  return `${baseName} (${stageLabel})`;
}
