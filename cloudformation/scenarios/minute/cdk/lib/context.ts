import { Construct } from 'constructs';

export type MinuteAuthMode = 'magic-link' | 'cognito';

export function getAuthMode(scope: Construct): MinuteAuthMode {
  const value = scope.node.tryGetContext('minute:authMode');
  return value === 'cognito' ? 'cognito' : 'magic-link';
}

export function isContextEnabled(
  scope: Construct,
  key: string,
  defaultValue = true,
): boolean {
  const value = scope.node.tryGetContext(key);
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return !['false', '0', 'no'].includes(String(value).toLowerCase());
}

export function getContextNumber(
  scope: Construct,
  key: string,
  defaultValue: number,
): number {
  const value = scope.node.tryGetContext(key);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/** Comma-separated country codes (ISO 3166-1 alpha-2). Use `none` to disable. */
export function getContextCountryList(
  scope: Construct,
  key: string,
  defaultValue: string[],
): string[] {
  const value = scope.node.tryGetContext(key);
  if (value === undefined) {
    return defaultValue;
  }
  if (value === '' || value === 'none' || value === 'false') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return String(value)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}
